import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
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
import { listBudgets } from './budgets-list.ts';
import {
  budgetSelect,
  lockBudget,
  lockReservation,
  reservationFingerprint,
  snapshot,
  updateBudget,
  type BudgetRow,
} from './budget-support.ts';

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
    return listBudgets(this.pool, workspaceId, limitInput, cursorInput);
  }

  async reserve(input: BudgetReservationInput): Promise<ReservationResult> {
    const amount = parseMinor(input.amountPaise);
    if (!input.reservationId || !input.sourceRef)
      throw new TypeError('Reservation provenance is required');
    if (
      (input.holder || input.expiresAt || input.sessionId) &&
      (!input.holder ||
        !input.expiresAt ||
        !input.sessionId ||
        !Number.isFinite(input.expiresAt.getTime()))
    )
      throw new TypeError('Durable reservation requires holder, expiry and session');
    return await transaction(this.pool, async (client) => {
      const budget = await lockBudget(client, input.budgetId);
      const prior = await client.query(
        `SELECT id,fingerprint,state,expires_at FROM ovo_cost_reservations WHERE id=$1`,
        [input.reservationId],
      );
      if (prior.rowCount) {
        if (prior.rows[0]!.fingerprint !== reservationFingerprint(input))
          throw new LedgerConflictError('Reservation identity conflicts with existing content');
        if (
          prior.rows[0]!.state !== 'reserved' ||
          (prior.rows[0]!.expires_at && new Date(prior.rows[0]!.expires_at).getTime() <= Date.now())
        )
          return {
            admitted: false,
            reservationId: input.reservationId,
            state: prior.rows[0]!.state,
            reason: 'reservation-not-active',
            budget: snapshot(budget),
          };
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
        `INSERT INTO ovo_cost_reservations
           (id,fingerprint,budget_id,amount_paise,source_ref,state,holder,expires_at,session_id,
            carrier_provider,carrier_meter_key,carrier_price_card_id,carrier_price_card_version,carrier_fx_id,carrier_fx_version)
         VALUES($1,$2,$3,$4,$5,'reserved',$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          input.reservationId,
          reservationFingerprint(input),
          input.budgetId,
          input.amountPaise,
          input.sourceRef,
          input.holder ?? null,
          input.expiresAt ?? null,
          input.sessionId ?? null,
          input.carrierUsage?.provider ?? null,
          input.carrierUsage?.meterKey ?? null,
          input.carrierUsage?.priceCard.id ?? null,
          input.carrierUsage?.priceCard.version ?? null,
          input.carrierUsage?.fx?.id ?? null,
          input.carrierUsage?.fx?.version ?? null,
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

  async extend(id: string, holder: string, until: Date): Promise<boolean> {
    if (!id || !holder || !Number.isFinite(until.getTime()))
      throw new TypeError('Reservation extension requires id, holder and expiry');
    const result = await this.pool.query(
      `UPDATE ovo_cost_reservations SET expires_at = GREATEST(expires_at, $3::timestamptz)
       WHERE id = $1 AND holder = $2 AND state = 'reserved' AND expires_at IS NOT NULL`,
      [id, holder, until],
    );
    return result.rowCount === 1;
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
