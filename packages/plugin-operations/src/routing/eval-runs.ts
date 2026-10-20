import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  RoutingEvalCase,
  RoutingScorecard,
  type RoutingEvalRun,
  type RoutingEvalRunSummary,
} from '@winsendotai/ovo-contracts';
import { boundedLimit } from '../database.ts';
import { uuidOrNull } from './rows.ts';

export interface RoutingEvalRunInput {
  routingReleaseId: string;
  name: string;
  corpusDigest: string;
  scorecard: RoutingScorecard;
  /** The cases that were scored; kept so a run can be inspected and rerun. */
  corpus: readonly RoutingEvalCase[];
  createdBy: string;
}

interface RunRow {
  id: string;
  name: string;
  routing_release_id: string;
  routing_point_id: string;
  release_version: number;
  created_at: Date;
  created_by: string;
  engine_mode: 'recorded';
  case_count: number;
  corpus_digest: string;
  passed: number | null;
  total: number | null;
  accuracy: number | null;
  fallback_rate: number | null;
  clarify_rate: number | null;
  scorecard?: RoutingScorecard;
}

/** The headline figures are read out of the scorecard in SQL, so a list never loads scorecards. */
const COLUMNS = `id, name, routing_release_id, routing_point_id, release_version, created_at,
  created_by, engine_mode, case_count, corpus_digest,
  (scorecard #>> '{totals,passed}')::int AS passed,
  (scorecard #>> '{totals,cases}')::int AS total,
  (scorecard #>> '{accuracy,overall,rate}')::float8 AS accuracy,
  (scorecard #>> '{fallbackRate,rate}')::float8 AS fallback_rate,
  (scorecard #>> '{clarifyRate,rate}')::float8 AS clarify_rate`;

function summary(row: RunRow): RoutingEvalRunSummary {
  return {
    id: row.id,
    name: row.name,
    routingReleaseId: row.routing_release_id,
    routingPointId: row.routing_point_id,
    releaseVersion: Number(row.release_version),
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
    engineMode: row.engine_mode,
    caseCount: Number(row.case_count),
    headline: {
      passed: Number(row.passed ?? 0),
      total: Number(row.total ?? 0),
      accuracy: row.accuracy === null ? null : Number(row.accuracy),
      fallbackRate: row.fallback_rate === null ? null : Number(row.fallback_rate),
      clarifyRate: row.clarify_rate === null ? null : Number(row.clarify_rate),
    },
  };
}

/** R4 eval runs: organization-scoped, soft-deleted, tied to the routing release they scored. */
export class RoutingEvalRuns {
  constructor(
    private readonly pool: Pool,
    private readonly organizationId: string,
  ) {}

  /** Undefined when the release is not in this organization. */
  async create(input: RoutingEvalRunInput): Promise<RoutingEvalRun | undefined> {
    const scorecard = RoutingScorecard.parse(input.scorecard);
    const corpus = input.corpus.map((found) => RoutingEvalCase.parse(found));
    if (!corpus.length) throw new Error('An eval run scores at least one case');
    if (!input.createdBy.trim()) throw new Error('createdBy is required');
    if (!uuidOrNull(input.routingReleaseId)) return undefined;
    const id = randomUUID();
    const result = await this.pool.query<RunRow>(
      `INSERT INTO ovo_routing_eval_runs (organization_id, id, routing_release_id, routing_point_id,
         release_version, name, engine_mode, corpus_digest, case_count, scorecard, corpus, created_by)
       SELECT $1, $2, r.id, r.routing_point_id, r.version, $4, 'recorded', $5, $6, $7::jsonb,
         $8::jsonb, $9
       FROM ovo_routing_releases r WHERE r.organization_id = $1 AND r.id = $3
       RETURNING ${COLUMNS}`,
      [
        this.organizationId,
        id,
        input.routingReleaseId,
        input.name,
        input.corpusDigest,
        corpus.length,
        JSON.stringify(scorecard),
        JSON.stringify(corpus),
        input.createdBy,
      ],
    );
    const row = result.rows[0];
    return row && { ...summary(row), corpusDigest: row.corpus_digest, scorecard };
  }

  /** Newest first; the cursor is the id of the last run of the previous page. */
  async list(limit: number, cursor?: string): Promise<RoutingEvalRunSummary[]> {
    const result = await this.pool.query<RunRow>(
      `SELECT ${COLUMNS} FROM ovo_routing_eval_runs
       WHERE organization_id = $1 AND deleted_at IS NULL
         AND ($2::uuid IS NULL OR (created_at, id) < (SELECT created_at, id FROM ovo_routing_eval_runs
           WHERE organization_id = $1 AND id = $2))
       ORDER BY created_at DESC, id DESC LIMIT $3`,
      [this.organizationId, uuidOrNull(cursor), boundedLimit(limit)],
    );
    return result.rows.map(summary);
  }

  async get(id: string): Promise<RoutingEvalRun | undefined> {
    if (!uuidOrNull(id)) return undefined;
    const result = await this.pool.query<RunRow>(
      `SELECT ${COLUMNS}, scorecard FROM ovo_routing_eval_runs
       WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [this.organizationId, id],
    );
    const row = result.rows[0];
    return row && { ...summary(row), corpusDigest: row.corpus_digest, scorecard: row.scorecard! };
  }

  /** The cases the run scored. */
  async corpus(id: string): Promise<RoutingEvalCase[] | undefined> {
    if (!uuidOrNull(id)) return undefined;
    const result = await this.pool.query<{ corpus: RoutingEvalCase[] }>(
      `SELECT corpus FROM ovo_routing_eval_runs
       WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [this.organizationId, id],
    );
    return result.rows[0]?.corpus;
  }

  /** False when the run is unknown or already deleted. */
  async softDelete(id: string): Promise<boolean> {
    if (!uuidOrNull(id)) return false;
    const result = await this.pool.query(
      `UPDATE ovo_routing_eval_runs SET deleted_at = now()
       WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [this.organizationId, id],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
