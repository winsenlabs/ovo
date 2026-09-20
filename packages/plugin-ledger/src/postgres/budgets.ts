import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { parseMinor } from '../money.ts';
import type {
  BudgetPolicy,
  BudgetReservationInput,
  BudgetSnapshot,
  LedgerPage,
  ReservationResult,
} from '../types.ts';
import { LedgerConflictError } from '../types.ts';
import { transaction } from './database.ts';
import { fingerprint } from './fingerprint.ts';
import { decodeCursor, pageFromRows, pageLimit } from './pagination.ts';

interface BudgetRow {
  id: string;
  workspace_id: string;
  limit_paise: string;
  admission_overspend_paise: string;
  spent_paise: string;
  reserved_paise: string;
}

export class BudgetRepository {
  constructor(private readonly pool: Pool) {}

  async create(policy: BudgetPolicy): Promise<BudgetSnapshot> {
    parseMinor(policy.limitPaise);
    parseMinor(policy.admissionOverspendPaise);
    if (!policy.id || !policy.workspaceId) throw new TypeError('Budget identity is required');
    const digest = fingerprint(policy);
    const result = await this.pool.query<BudgetRow>(
      `INSERT INTO ovo_cost_budgets
       (id,fingerprint,workspace_id,limit_paise,admission_overspend_paise)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(id) DO UPDATE SET
         fingerprint=EXCLUDED.fingerprint,
         limit_paise=EXCLUDED.limit_paise,
         admission_overspend_paise=EXCLUDED.admission_overspend_paise,
         updated_at=now()
       WHERE ovo_cost_budgets.workspace_id=EXCLUDED.workspace_id
       RETURNING id,workspace_id,limit_paise::text,admission_overspend_paise::text,
                 spent_paise::text,reserved_paise::text`,
      [policy.id, digest, policy.workspaceId, policy.limitPaise, policy.admissionOverspendPaise],
    );
    if (!result.rowCount)
      throw new LedgerConflictError('Budget identity belongs to another workspace');
    return snapshot(result.rows[0]!);
  }

  async get(id: string): Promise<BudgetSnapshot | undefined> {
    const result = await this.pool.query<BudgetRow>(budgetSelect('WHERE id=$1'), [id]);
    return result.rows[0] ? snapshot(result.rows[0]) : undefined;
  }

  async list(
    workspaceId: string,
    limitInput?: number,
    cursorInput?: string,
  ): Promise<LedgerPage<BudgetSnapshot>> {
    if (!workspaceId) throw new TypeError('Budget workspace is required');
    const limit = pageLimit(limitInput),
      cursor = decodeCursor(cursorInput);
    if (cursor?.version) throw new TypeError('Budget cursor is invalid');
    const result = await this.pool.query<BudgetRow & { updated_at: string }>(
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

  async reserve(input: BudgetReservationInput): Promise<ReservationResult> {
    const amount = parseMinor(input.amountPaise);
    if (!input.reservationId || !input.sourceRef)
      throw new TypeError('Reservation provenance is required');
    return await transaction(this.pool, async (client) => {
      const budget = await lockBudget(client, input.budgetId);
      const prior = await client.query(
        `SELECT id,fingerprint,state FROM ovo_cost_reservations WHERE id=$1`,
        [input.reservationId],
      );
      if (prior.rowCount) {
        if (prior.rows[0]!.fingerprint !== fingerprint(input))
          throw new LedgerConflictError('Reservation identity conflicts with existing content');
        return {
          admitted: true,
          reservationId: input.reservationId,
          state: prior.rows[0]!.state,
          budget: snapshot(budget),
        };
      }
      const ceiling = BigInt(budget.limit_paise) + BigInt(budget.admission_overspend_paise);
      if (BigInt(budget.spent_paise) + BigInt(budget.reserved_paise) + amount > ceiling)
        return {
          admitted: false,
          reservationId: input.reservationId,
          reason: 'budget-threshold',
          budget: snapshot(budget),
        };
      await client.query(
        `INSERT INTO ovo_cost_reservations(id,fingerprint,budget_id,amount_paise,source_ref,state)
         VALUES($1,$2,$3,$4,$5,'reserved')`,
        [
          input.reservationId,
          fingerprint(input),
          input.budgetId,
          input.amountPaise,
          input.sourceRef,
        ],
      );
      const updated = await updateBudget(client, input.budgetId, 0n, amount);
      return {
        admitted: true,
        reservationId: input.reservationId,
        state: 'reserved',
        budget: snapshot(updated),
      };
    });
  }

  async settle(reservationId: string, actualPaise: string): Promise<ReservationResult> {
    const actual = parseMinor(actualPaise);
    return await transaction(this.pool, async (client) => {
      const reservation = await lockReservation(client, reservationId);
      const budget = await lockBudget(client, reservation.budget_id);
      if (reservation.state === 'settled') {
        if (String(reservation.actual_paise) !== actualPaise)
          throw new LedgerConflictError('Settled reservation actual amount is immutable');
        return { admitted: true, reservationId, state: 'settled', budget: snapshot(budget) };
      }
      if (reservation.state === 'released')
        throw new LedgerConflictError('Released reservation cannot settle');
      await client.query(
        `UPDATE ovo_cost_reservations SET state='settled',actual_paise=$2,settled_at=now() WHERE id=$1`,
        [reservationId, actualPaise],
      );
      const updated = await updateBudget(
        client,
        reservation.budget_id,
        actual,
        -BigInt(reservation.amount_paise),
      );
      return { admitted: true, reservationId, state: 'settled', budget: snapshot(updated) };
    });
  }

  async release(reservationId: string): Promise<ReservationResult> {
    return await transaction(this.pool, async (client) => {
      const reservation = await lockReservation(client, reservationId);
      const budget = await lockBudget(client, reservation.budget_id);
      if (reservation.state === 'released')
        return { admitted: true, reservationId, state: 'released', budget: snapshot(budget) };
      if (reservation.state === 'settled')
        throw new LedgerConflictError('Settled reservation cannot release');
      await client.query(
        "UPDATE ovo_cost_reservations SET state='released',settled_at=now() WHERE id=$1",
        [reservationId],
      );
      const updated = await updateBudget(
        client,
        reservation.budget_id,
        0n,
        -BigInt(reservation.amount_paise),
      );
      return { admitted: true, reservationId, state: 'released', budget: snapshot(updated) };
    });
  }

  async adjust(input: {
    budgetId: string;
    idempotencyKey: string;
    deltaPaise: string;
    sourceRef: string;
  }): Promise<BudgetSnapshot> {
    const delta = parseMinor(input.deltaPaise, true);
    return await transaction(this.pool, async (client) => {
      const budget = await lockBudget(client, input.budgetId);
      const prior = await client.query(
        'SELECT fingerprint FROM ovo_cost_budget_adjustments WHERE idempotency_key=$1',
        [input.idempotencyKey],
      );
      if (prior.rowCount) {
        if (prior.rows[0]!.fingerprint !== fingerprint(input))
          throw new LedgerConflictError('Budget adjustment idempotency conflict');
        return snapshot(budget);
      }
      if (BigInt(budget.spent_paise) + delta < 0n)
        throw new RangeError('Late adjustment cannot make incurred spend negative');
      await client.query(
        `INSERT INTO ovo_cost_budget_adjustments
         (id,idempotency_key,fingerprint,budget_id,delta_paise,source_ref)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [
          randomUUID(),
          input.idempotencyKey,
          fingerprint(input),
          input.budgetId,
          input.deltaPaise,
          input.sourceRef,
        ],
      );
      return snapshot(await updateBudget(client, input.budgetId, delta, 0n));
    });
  }
}

async function lockBudget(client: PoolClient, id: string): Promise<BudgetRow> {
  const result = await client.query<BudgetRow>(budgetSelect('WHERE id=$1 FOR UPDATE'), [id]);
  if (!result.rowCount) throw new Error('Budget not found');
  return result.rows[0]!;
}

async function lockReservation(client: PoolClient, id: string): Promise<any> {
  const result = await client.query('SELECT * FROM ovo_cost_reservations WHERE id=$1 FOR UPDATE', [
    id,
  ]);
  if (!result.rowCount) throw new Error('Reservation not found');
  return result.rows[0]!;
}

async function updateBudget(
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

function budgetSelect(suffix: string): string {
  return `SELECT id,workspace_id,limit_paise::text,admission_overspend_paise::text,
                 spent_paise::text,reserved_paise::text FROM ovo_cost_budgets ${suffix}`;
}

function snapshot(row: BudgetRow): BudgetSnapshot {
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
