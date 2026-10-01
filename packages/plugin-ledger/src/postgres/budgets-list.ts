import type { Pool } from 'pg';
import type { BudgetSnapshot, LedgerPage } from '../types.ts';
import { snapshot, type BudgetRow } from './budget-support.ts';
import { decodeCursor, pageFromRows, pageLimit } from './pagination.ts';

export async function listBudgets(
  pool: Pool,
  workspaceId: string,
  limitInput?: number,
  cursorInput?: string,
): Promise<LedgerPage<BudgetSnapshot>> {
  if (!workspaceId) throw new TypeError('Budget workspace is required');
  const limit = pageLimit(limitInput),
    cursor = decodeCursor(cursorInput);
  if (cursor?.version) throw new TypeError('Budget cursor is invalid');
  const result = await pool.query<BudgetRow & { updated_at: string }>(
    `SELECT id,workspace_id,limit_paise::text,admission_overspend_paise::text,
            spent_paise::text,reserved_paise::text,updated_at::text
     FROM ovo_cost_budgets WHERE workspace_id=$1
     ${cursor ? 'AND (updated_at,id) < ($2::timestamptz,$3)' : ''}
     ORDER BY updated_at DESC,id DESC LIMIT $${cursor ? 4 : 2}`,
    cursor ? [workspaceId, cursor.timestamp, cursor.id, limit + 1] : [workspaceId, limit + 1],
  );
  return pageFromRows(
    result.rows.map((row) => ({
      cursor: { timestamp: new Date(row.updated_at).toISOString(), id: row.id },
      row,
    })),
    limit,
    ({ row }) => snapshot(row),
  );
}
