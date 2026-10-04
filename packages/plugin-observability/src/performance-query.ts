import type { Pool } from 'pg';
import {
  PERFORMANCE_GROUPS,
  type PerformanceGroup,
  type PerformanceQuery,
  type PerformanceResult,
} from './telemetry-types.ts';

const columns: Record<PerformanceGroup, string> = {
  agent: 'agent_id',
  release: 'release_id',
  provider: 'provider',
  model: 'model',
  language: 'language',
  stage: 'stage',
  source: 'source',
  time: '',
};

export async function runPerformanceQuery(
  pool: Pool,
  workspaceId: string,
  query: PerformanceQuery,
  maxWindowDays: number,
): Promise<PerformanceResult> {
  const from = new Date(query.from);
  const to = new Date(query.to);
  if (!Number.isFinite(from.valueOf()) || !Number.isFinite(to.valueOf()) || from >= to)
    throw new Error('Invalid performance time window');
  if (to.valueOf() - from.valueOf() > maxWindowDays * 86_400_000)
    throw new Error(`Performance time window exceeds ${maxWindowDays} days`);
  const groupBy = [...new Set(query.groupBy ?? PERFORMANCE_GROUPS)];
  if (groupBy.some((group) => !PERFORMANCE_GROUPS.includes(group)))
    throw new Error('Invalid performance grouping');
  const maxGroups = clamp(query.maxGroups ?? 100, 1, 200);
  const callLimit = clamp(query.callLimit ?? 25, 0, 50);
  const params: unknown[] = [workspaceId, from.toISOString(), to.toISOString()];
  const filters = [
    'workspace_id=$1',
    'COALESCE(finished_at,started_at) >= $2',
    'COALESCE(finished_at,started_at) < $3',
  ];
  addFilter(filters, params, 'agent_id', query.agentId);
  addFilter(filters, params, 'release_id', query.releaseId);
  addFilter(filters, params, 'provider', query.provider);
  addFilter(filters, params, 'model', query.model);
  addFilter(filters, params, 'language', query.language);
  addFilter(filters, params, 'stage', query.stage);
  addFilter(filters, params, 'source', query.source);
  const expressions = groupBy.map((group) => {
    if (group === 'time') return `date_trunc('${query.bucket}',COALESCE(finished_at,started_at))`;
    return columns[group];
  });
  const selected = expressions.map((expression, index) => `${expression} AS g${index}`);
  params.push(callLimit, maxGroups + 1);
  const result = await pool.query<Record<string, unknown>>(
    `SELECT ${selected.length ? `${selected.join(',')},` : ''}
       COUNT(*)::int AS event_count,
       COUNT(duration_ms)::int AS sample_count,
       COUNT(DISTINCT call_id)::int AS call_count,
       COUNT(*) FILTER (WHERE outcome IN ('failed','unknown'))::int AS errors,
       COUNT(*) FILTER (WHERE outcome='timeout')::int AS timeouts,
       percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_ms) AS p50,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95,
       percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms) AS p99,
       (array_agg(DISTINCT call_id))[1:$${params.length - 1}] AS call_ids
     FROM ovo_telemetry_stages
     WHERE ${filters.join(' AND ')}
     ${expressions.length ? `GROUP BY ${expressions.join(',')}` : ''}
     ORDER BY ${expressions.length ? `${expressions.at(-1)} DESC NULLS LAST,` : ''} COUNT(*) DESC
     LIMIT $${params.length}`,
    params,
  );
  const truncated = result.rows.length > maxGroups;
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    bucket: query.bucket,
    truncated,
    groups: result.rows.slice(0, maxGroups).map((row) => ({
      cohort: Object.fromEntries(
        groupBy.map((group, index) => [group, cohortValue(row[`g${index}`])]),
      ),
      eventCount: Number(row.event_count),
      sampleCount: Number(row.sample_count),
      callCount: Number(row.call_count),
      errors: Number(row.errors),
      timeouts: Number(row.timeouts),
      p50Ms: metric(row.p50),
      p95Ms: metric(row.p95),
      p99Ms: metric(row.p99),
      callIds: callLimit ? ([...new Set((row.call_ids as string[] | null) ?? [])] as string[]) : [],
    })),
  };
}

function addFilter(filters: string[], params: unknown[], column: string, value?: string): void {
  if (value === undefined) return;
  params.push(value);
  filters.push(`${column}=$${params.length}`);
}

function cohortValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function metric(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value)) throw new Error('Performance limit must be an integer');
  return Math.min(maximum, Math.max(minimum, value));
}
