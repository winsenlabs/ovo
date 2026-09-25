import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { allocateMinor, parseDecimal } from '../money.ts';
import type { AllocateChargeInput, AllocationResult } from '../types.ts';
import { LedgerConflictError } from '../types.ts';
import { transaction } from './database.ts';
import { fingerprint } from './fingerprint.ts';

export class AllocationRepository {
  constructor(private readonly pool: Pool) {}

  async allocate(input: AllocateChargeInput): Promise<AllocationResult> {
    validate(input);
    return await transaction(this.pool, async (client) => {
      const prior = await client.query(
        `SELECT id,fingerprint,charge_id,amount_paise::text,basis
         FROM ovo_cost_allocation_batches WHERE idempotency_key=$1`,
        [input.idempotencyKey],
      );
      if (prior.rowCount) {
        if (prior.rows[0]!.fingerprint !== fingerprint(input))
          throw new LedgerConflictError('Allocation idempotency conflicts with existing content');
        return loadAllocation(client, prior.rows[0]!.id);
      }
      const charge = await client.query(
        `SELECT id,usage_id,amount_paise::text FROM ovo_cost_charges WHERE id=$1 FOR UPDATE`,
        [input.chargeId],
      );
      if (!charge.rowCount) throw new Error('Charge not found');
      const corrections = await client.query(
        `SELECT COALESCE(SUM(delta_paise),0)::text AS total
         FROM ovo_cost_corrections WHERE usage_id=$1`,
        [charge.rows[0]!.usage_id],
      );
      const amount = (
        BigInt(String(charge.rows[0]!.amount_paise)) + BigInt(corrections.rows[0]!.total)
      ).toString();
      const amounts = allocateMinor(
        amount,
        input.targets.map((target) => ({ id: target.id, weight: target.weight })),
      );
      const id = randomUUID();
      await client.query(
        `INSERT INTO ovo_cost_allocation_batches(id,idempotency_key,fingerprint,charge_id,amount_paise,basis)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [id, input.idempotencyKey, fingerprint(input), input.chargeId, amount, input.basis],
      );
      for (const target of input.targets)
        await client.query(
          `INSERT INTO ovo_cost_allocations
           (batch_id,target_id,weight,reason,call_id,attempt_id,amount_paise)
           VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            id,
            target.id,
            target.weight,
            target.reason,
            target.callId ?? null,
            target.attemptId ?? null,
            amounts.get(target.id),
          ],
        );
      return loadAllocation(client, id);
    });
  }
}

async function loadAllocation(client: any, id: string): Promise<AllocationResult> {
  const batch = await client.query(
    'SELECT id,charge_id,amount_paise::text,basis FROM ovo_cost_allocation_batches WHERE id=$1',
    [id],
  );
  const targets = await client.query(
    `SELECT target_id,weight,reason,call_id,attempt_id,amount_paise::text
     FROM ovo_cost_allocations WHERE batch_id=$1 ORDER BY target_id`,
    [id],
  );
  return {
    allocationId: id,
    chargeId: batch.rows[0]!.charge_id,
    amountPaise: batch.rows[0]!.amount_paise,
    basis: batch.rows[0]!.basis,
    targets: targets.rows.map((row: any) => ({
      id: row.target_id,
      weight: row.weight,
      reason: row.reason,
      callId: row.call_id ?? undefined,
      attemptId: row.attempt_id ?? undefined,
      amountPaise: row.amount_paise,
    })),
  };
}

function validate(input: AllocateChargeInput): void {
  if (!input.idempotencyKey || !input.chargeId || !input.basis || input.targets.length === 0)
    throw new TypeError('Allocation identity, basis and targets are required');
  for (const target of input.targets) {
    if (
      !target.id ||
      parseDecimal(target.weight).numerator < 0n ||
      !['failed-attempt', 'transfer', 'retry', 'worker-shared', 'shared-service'].includes(
        target.reason,
      )
    )
      throw new TypeError('Allocation targets require an ID and nonnegative weight');
  }
}
