import type { Pool } from 'pg';
import { canonicalJson, readSessionEvent, type CallOutcomeRoute } from '@winsendotai/ovo-contracts';
import { toIso, transaction } from '../postgres/shared.ts';
import { applySessionEvent, emptyCallOutcome } from './projection.ts';

export interface RefoldOptions {
  /** Write the refolded routes. Absent: report what would change and write nothing. */
  apply?: boolean;
  /** Calls looked at in one run (default 500, at most 5000). */
  limit?: number;
  /** Only calls whose outcome changed at or after this time. */
  since?: string;
}

export interface RefoldedCall {
  callId: string;
  before: CallOutcomeRoute;
  after: CallOutcomeRoute | null;
}

export interface RefoldReport {
  scanned: number;
  /** Calls whose route differs from its events' fold. */
  changed: RefoldedCall[];
  unchanged: number;
  /** Calls with an event that no longer parses, left as they are. */
  failed: { callId: string; reason: string }[];
  /** Routes written (0 in a dry run). */
  applied: number;
}

export const REFOLD_DEFAULT_LIMIT = 500;
export const REFOLD_MAX_LIMIT = 5_000;

/**
 * Rebuilds the `route` of routed calls recorded before Wave 18 (no `routeMs`, no fallback or re-ask
 * counts) from their session events with the same pure fold the store uses, so the calls filter and
 * the stats can see them. Only `route` is ever written; the rest of the summary is untouched. Each
 * call is read and written under the lock the store's own append takes, so a call still writing
 * events is folded whole or not at all. Idempotent: a refolded call no longer matches. Calls that
 * hung up while routing (no decision) have nothing to add and are not looked at.
 */
export async function refoldRoutesPg(
  pool: Pool,
  workspaceId: string,
  options: RefoldOptions = {},
): Promise<RefoldReport> {
  const limit = Math.min(
    Math.max(Math.trunc(options.limit ?? REFOLD_DEFAULT_LIMIT), 1),
    REFOLD_MAX_LIMIT,
  );
  const candidates = await pool.query<{ call_id: string }>(
    `SELECT call_id FROM ovo_call_outcomes
     WHERE workspace_id = $1 AND route IS NOT NULL AND route->>'routingPointId' <> ''
       AND (route->'routeMs' IS NULL OR route->'fallbacks' IS NULL)
       AND ($2::timestamptz IS NULL OR updated_at >= $2)
     ORDER BY updated_at DESC, call_id DESC LIMIT $3`,
    [workspaceId, options.since ?? null, limit],
  );
  const report: RefoldReport = {
    scanned: candidates.rows.length,
    changed: [],
    unchanged: 0,
    failed: [],
    applied: 0,
  };
  for (const { call_id: callId } of candidates.rows) {
    await transaction(pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
        workspaceId,
        callId,
      ]);
      const stored = await client.query<{ route: CallOutcomeRoute | null }>(
        'SELECT route FROM ovo_call_outcomes WHERE workspace_id = $1 AND call_id = $2 FOR UPDATE',
        [workspaceId, callId],
      );
      const before = stored.rows[0]?.route;
      if (!before) return;
      const events = await client.query<{ type: string; payload: unknown; at: Date }>(
        `SELECT type, payload, at FROM ovo_session_events
         WHERE workspace_id = $1 AND call_id = $2 ORDER BY sequence`,
        [workspaceId, callId],
      );
      let folded;
      try {
        folded = emptyCallOutcome(
          callId,
          events.rows[0] ? toIso(events.rows[0].at) : new Date(0).toISOString(),
        );
        for (const row of events.rows)
          folded = applySessionEvent(
            folded,
            readSessionEvent(row.type, row.payload),
            toIso(row.at),
          );
      } catch (error) {
        report.failed.push({
          callId,
          reason: error instanceof Error ? error.message.slice(0, 200) : 'unreadable event',
        });
        return;
      }
      if (canonicalJson(folded.route) === canonicalJson(before)) {
        report.unchanged += 1;
        return;
      }
      report.changed.push({ callId, before, after: folded.route });
      if (!options.apply || !folded.route) return;
      await client.query(
        'UPDATE ovo_call_outcomes SET route = $3::jsonb WHERE workspace_id = $1 AND call_id = $2',
        [workspaceId, callId, JSON.stringify(folded.route)],
      );
      report.applied += 1;
    });
  }
  return report;
}
