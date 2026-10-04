import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { ReconcileUsageInput, ReconciliationResult } from '../types.ts';
import { LedgerConflictError } from '../types.ts';
import { fingerprint } from './fingerprint.ts';

export async function applySettledBudgetCorrection(
  client: PoolClient,
  input: { correctionId: string; sessionId: string; deltaPaise: string },
): Promise<void> {
  const reservation = await client.query(
    `SELECT budget_id FROM ovo_cost_reservations
     WHERE id=$1 AND state='settled' FOR UPDATE`,
    [input.sessionId],
  );
  if (!reservation.rowCount) return;
  const budgetId = reservation.rows[0]!.budget_id;
  await client.query('SELECT id FROM ovo_cost_budgets WHERE id=$1 FOR UPDATE', [budgetId]);
  const adjustment = {
    budgetId,
    idempotencyKey: `invoice-correction:${input.correctionId}`,
    deltaPaise: input.deltaPaise,
    sourceRef: `provider-invoice-correction:${input.correctionId}`,
  };
  await client.query(
    `INSERT INTO ovo_cost_budget_adjustments
     (id,idempotency_key,fingerprint,budget_id,delta_paise,source_ref)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [
      randomUUID(),
      adjustment.idempotencyKey,
      fingerprint(adjustment),
      budgetId,
      input.deltaPaise,
      adjustment.sourceRef,
    ],
  );
  await client.query(
    'UPDATE ovo_cost_budgets SET spent_paise=spent_paise+$2,updated_at=now() WHERE id=$1',
    [budgetId, input.deltaPaise],
  );
}

export async function findCorrection(client: PoolClient, input: ReconcileUsageInput) {
  const result = await client.query(
    `SELECT id,idempotency_key,fingerprint,usage_id,delta_paise::text,effective_amount_paise::text
     FROM ovo_cost_corrections
     WHERE idempotency_key=$1 OR (provider_invoice_id=$2 AND provider_invoice_line_id=$3)
     LIMIT 1`,
    [input.idempotencyKey, input.providerInvoiceId, input.providerInvoiceLineId],
  );
  return result.rows[0];
}

export function validateCorrection(row: any, input: ReconcileUsageInput): ReconciliationResult {
  if (row.fingerprint !== correctionFingerprint(input))
    throw new LedgerConflictError('Correction idempotency conflicts with existing content');
  return {
    usageId: row.usage_id,
    correctionId: row.id,
    deltaPaise: row.delta_paise,
    effectiveAmountPaise: row.effective_amount_paise,
    state: 'reconciled',
  };
}

export function correctionFingerprint(input: ReconcileUsageInput): string {
  const { idempotencyKey: _, ...content } = input;
  return fingerprint(content);
}
