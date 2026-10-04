import type { PoolClient } from 'pg';
import type { BudgetReservationInput, BudgetSnapshot } from '../types.ts';
import { fingerprint } from './fingerprint.ts';

export interface BudgetRow {
  id: string;
  workspace_id: string;
  limit_paise: string;
  admission_overspend_paise: string;
  spent_paise: string;
  reserved_paise: string;
}

export async function lockBudget(client: PoolClient, id: string): Promise<BudgetRow> {
  const result = await client.query<BudgetRow>(budgetSelect('WHERE id=$1 FOR UPDATE'), [id]);
  if (!result.rowCount) throw new Error('Budget not found');
  return result.rows[0]!;
}

export async function lockReservation(client: PoolClient, id: string): Promise<any> {
  const result = await client.query('SELECT * FROM ovo_cost_reservations WHERE id=$1 FOR UPDATE', [
    id,
  ]);
  if (!result.rowCount) throw new Error('Reservation not found');
  return result.rows[0]!;
}

export async function updateBudget(
  client: PoolClient,
  id: string,
  spentDelta: bigint,
  reservedDelta: bigint,
): Promise<BudgetRow> {
  const result = await client.query<BudgetRow>(
    `UPDATE ovo_cost_budgets
     SET spent_paise=spent_paise+$2,reserved_paise=reserved_paise+$3,updated_at=now()
     WHERE id=$1
     RETURNING id,workspace_id,limit_paise::text,admission_overspend_paise::text,
               spent_paise::text,reserved_paise::text`,
    [id, spentDelta.toString(), reservedDelta.toString()],
  );
  return result.rows[0]!;
}

export function budgetSelect(suffix: string): string {
  return `SELECT id,workspace_id,limit_paise::text,admission_overspend_paise::text,
                 spent_paise::text,reserved_paise::text FROM ovo_cost_budgets ${suffix}`;
}

export function snapshot(row: BudgetRow): BudgetSnapshot {
  const ceiling = BigInt(row.limit_paise) + BigInt(row.admission_overspend_paise);
  const committed = BigInt(row.spent_paise) + BigInt(row.reserved_paise);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    limitPaise: row.limit_paise,
    admissionOverspendPaise: row.admission_overspend_paise,
    spentPaise: row.spent_paise,
    reservedPaise: row.reserved_paise,
    availableForAdmissionPaise: (ceiling > committed ? ceiling - committed : 0n).toString(),
    overLimit: BigInt(row.spent_paise) > BigInt(row.limit_paise),
  };
}

export function reservationFingerprint(input: BudgetReservationInput): string {
  const { expiresAt: _expiresAt, ...identity } = input;
  return fingerprint(identity);
}
