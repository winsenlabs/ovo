import type { Pool, PoolClient } from 'pg';
import type { CallCostSummary, CostSummary } from '../types.ts';

/**
 * Estimated and reconciled paise for the usage rows `scope` selects (a predicate on `u`). P11:
 * estimated charges add their exact values and round to paise once for the whole scope, so a call
 * of many sub-paise LLM steps costs what the steps add up to instead of 0. A reconciled charge is
 * already a whole invoice amount, and a charge recorded before migration 004 has only its rounded
 * value.
 */
export function costTotalsQuery(scope: string): string {
  return `WITH effective AS (
      SELECT u.state,
             COALESCE(c.exact_amount_paise, c.amount_paise) AS exact,
             c.amount_paise + COALESCE(SUM(x.delta_paise),0) AS amount
      FROM ovo_cost_native_usage u
      JOIN ovo_cost_charges c ON c.usage_id=u.id
      LEFT JOIN ovo_cost_corrections x ON x.usage_id=u.id
      WHERE ${scope}
      GROUP BY u.id,c.id
    ), totals AS (
      SELECT ROUND(COALESCE(SUM(exact) FILTER (WHERE state='estimated'),0)) AS estimated,
             COALESCE(SUM(amount) FILTER (WHERE state='reconciled'),0) AS reconciled
      FROM effective
    )
    SELECT estimated::text AS estimated, reconciled::text AS reconciled,
           (estimated + reconciled)::text AS total FROM totals`;
}

export interface CostTotals {
  estimated: string;
  reconciled: string;
  total: string;
}

export async function costTotals(
  db: Pool | PoolClient,
  scope: string,
  values: unknown[],
): Promise<CostTotals> {
  const result = await db.query<CostTotals>(costTotalsQuery(scope), values);
  return result.rows[0]!;
}

/** The provisional price-card versions any charge in `scope` was priced with (OPS-13). */
export async function provisionalCards(
  db: Pool | PoolClient,
  scope: string,
  values: unknown[],
): Promise<{ id: string; version: string }[]> {
  const result = await db.query<{ id: string; version: string }>(
    `SELECT DISTINCT p.id,p.version
     FROM ovo_cost_native_usage u
     JOIN ovo_cost_charges c ON c.usage_id=u.id
     JOIN ovo_cost_price_cards p ON p.id=c.price_card_id AND p.version=c.price_card_version
     WHERE ${scope} AND p.provisional
     ORDER BY p.id,p.version`,
    values,
  );
  return result.rows.map(({ id, version }) => ({ id, version }));
}

export async function summarizeSession(
  pool: Pool,
  workspaceId: string,
  sessionId: string,
): Promise<CostSummary> {
  const { totals, provisional } = await summarize(pool, 'u.session_id=$2', [
    workspaceId,
    sessionId,
  ]);
  return { workspaceId, sessionId, currency: 'INR', ...totals, ...provisional };
}

/**
 * P11: a call's cost across every ledger session that metered it. Usage is keyed by the media
 * session id the worker reserved under, which is not the call id; each row also carries the call
 * id, so the call's sessions are found through it (a session keyed by the call id itself counts
 * too). Estimated charges round to paise once for the whole call.
 */
export async function summarizeCall(
  pool: Pool,
  workspaceId: string,
  callId: string,
): Promise<CallCostSummary> {
  const sessions = await pool.query<{ session_id: string }>(
    `SELECT DISTINCT session_id FROM ovo_cost_native_usage
     WHERE workspace_id=$1 AND (call_id=$2 OR session_id=$2) ORDER BY session_id`,
    [workspaceId, callId],
  );
  const sessionIds = sessions.rows.map((row) => row.session_id);
  const { totals, provisional } = await summarize(pool, 'u.session_id=ANY($2::text[])', [
    workspaceId,
    sessionIds,
  ]);
  return { workspaceId, callId, sessionIds, currency: 'INR', ...totals, ...provisional };
}

async function summarize(pool: Pool, sessions: string, values: [string, unknown]) {
  const scope = `u.workspace_id=$1 AND ${sessions}`;
  const [totals, cards] = await Promise.all([
    costTotals(pool, scope, values),
    provisionalCards(pool, scope, values),
  ]);
  return {
    totals: {
      estimatedPaise: totals.estimated,
      reconciledPaise: totals.reconciled,
      totalPaise: totals.total,
    },
    provisional: { provisional: cards.length > 0, provisionalPriceCards: cards },
  };
}
