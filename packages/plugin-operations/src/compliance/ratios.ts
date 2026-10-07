import type { WorkspaceCompliance } from '@winsendotai/ovo-contracts';
import type { Database } from '../types.ts';

/**
 * The telco's autodialler detection criteria (TCCCPR 2018 Sch. IV item 3, R18): abandoned calls
 * over 3% or silent calls over 1% of attempts in 24 hours. Here an answered attempt is abandoned
 * when no agent session opened on it, and silent when it ended within `silentCallSeconds` of the
 * answer. An AI agent counts as the live agent (Q5); `monitor` mode reports without pausing.
 */
export interface CliRatios {
  fromNumber: string;
  attempts: number;
  answered: number;
  abandoned: number;
  silent: number;
  abandonedRatio: number;
  silentRatio: number;
  level: 'ok' | 'warn' | 'stop';
  tripped: boolean;
}

export async function breakerState(
  db: Database,
  organizationId: string,
  fromNumber: string,
  settings: WorkspaceCompliance,
  now: Date,
): Promise<CliRatios> {
  const result = await db.query<{
    attempts: string;
    answered: string;
    abandoned: string;
    silent: string;
  }>(
    `SELECT count(*)::text AS attempts,
       count(*) FILTER (WHERE connected_at IS NOT NULL)::text AS answered,
       count(*) FILTER (WHERE connected_at IS NOT NULL AND outcome = 'abandoned')::text AS abandoned,
       count(*) FILTER (WHERE connected_at IS NOT NULL AND outcome IS DISTINCT FROM 'abandoned'
         AND ended_at < connected_at + make_interval(secs => $4))::text AS silent
     FROM ovo_ops_recipient_attempts
     WHERE organization_id = $1 AND from_number = $2
       AND authorized_at > $3::timestamptz - interval '24 hours'`,
    [organizationId, fromNumber, now, settings.breaker.silentCallSeconds],
  );
  const row = result.rows[0]!;
  const attempts = Number(row.attempts);
  const abandoned = Number(row.abandoned);
  const silent = Number(row.silent);
  const abandonedRatio = attempts ? abandoned / attempts : 0;
  const silentRatio = attempts ? silent / attempts : 0;
  const sampled = attempts >= settings.breaker.minAttempts;
  const stop =
    sampled &&
    (abandonedRatio >= settings.breaker.stopRatio ||
      silentRatio >= settings.breaker.silentStopRatio);
  const warn = sampled && abandonedRatio >= settings.breaker.warnRatio;
  return {
    fromNumber,
    attempts,
    answered: Number(row.answered),
    abandoned,
    silent,
    abandonedRatio,
    silentRatio,
    level: stop ? 'stop' : warn ? 'warn' : 'ok',
    tripped: stop,
  };
}

/** The ratios of every caller number used in the last 24 hours, for the compliance page. */
export async function allCliRatios(
  db: Database,
  organizationId: string,
  settings: WorkspaceCompliance,
  now = new Date(),
): Promise<CliRatios[]> {
  const numbers = await db.query<{ from_number: string }>(
    `SELECT DISTINCT from_number FROM ovo_ops_recipient_attempts
     WHERE organization_id = $1 AND authorized_at > $2::timestamptz - interval '24 hours'
     ORDER BY from_number LIMIT 100`,
    [organizationId, now],
  );
  const ratios: CliRatios[] = [];
  for (const row of numbers.rows)
    ratios.push(await breakerState(db, organizationId, row.from_number, settings, now));
  return ratios;
}
