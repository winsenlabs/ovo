import { randomUUID } from 'node:crypto';
import { priceUsage } from '@winsendotai/ovo-plugin-observability';
import type { Pool, PoolClient } from 'pg';
import { parseMinor } from '../money.ts';
import type {
  CostSummary,
  RecordedUsage,
  ReconcileUsageInput,
  ReconciliationResult,
  RecordUsageInput,
} from '../types.ts';
import { LedgerConflictError } from '../types.ts';
import { transaction } from './database.ts';
import { fingerprint } from './fingerprint.ts';
import { convertExplicit, getPriceCard, priceInInr } from './usage-pricing.ts';
import { validateReconciliation, validateUsage } from './usage-validation.ts';

interface ChargeRow {
  usage_id: string;
  charge_id: string;
  state: 'estimated' | 'reconciled';
  quantity: string;
  unit: string;
  native_amount_minor: string;
  native_currency: string;
  amount_paise: string;
  price_card_id: string;
  price_card_version: string;
  fx_id: string | null;
  fx_version: string | null;
}

export class UsageRepository {
  constructor(private readonly pool: Pool) {}

  async record(input: RecordUsageInput): Promise<RecordedUsage> {
    validateUsage(input);
    return await transaction(this.pool, async (client) => {
      const existing = await this.findExisting(client, input);
      if (existing) return existing;
      const card = await getPriceCard(client, input.priceCard.id, input.priceCard.version);
      if (card.provider !== input.provider || card.unit !== input.unit)
        throw new TypeError('Usage provider/native unit does not match the explicit price card');
      const usageId = input.usageId ?? randomUUID();
      const nativeAmount = priceUsage(
        {
          id: usageId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          provider: input.provider,
          providerRequestId: input.providerRequestId ?? input.sourceEventId,
          quantity: input.quantity,
          unit: input.unit,
          state: 'estimated',
        },
        card,
      ).amountMinor;
      const { amountPaise, fx } = await priceInInr(client, nativeAmount, card.currency, input.fx);
      const chargeId = randomUUID();
      const digest = usageFingerprint(input);
      const inserted = await client.query(
        `INSERT INTO ovo_cost_native_usage
           (id,idempotency_key,fingerprint,workspace_id,session_id,call_id,attempt_id,provider,
            provider_request_id,source_kind,source_event_type,source_event_id,activity,
            cache_disposition,quantity,unit,occurred_at,state)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'estimated')
           ON CONFLICT DO NOTHING RETURNING id`,
        [
          usageId,
          input.idempotencyKey,
          digest,
          input.workspaceId,
          input.sessionId,
          input.callId ?? null,
          input.attemptId ?? null,
          input.provider,
          input.providerRequestId ?? null,
          input.sourceKind,
          input.sourceEventType,
          input.sourceEventId,
          input.activity,
          input.cacheDisposition,
          input.quantity,
          input.unit,
          input.occurredAt,
        ],
      );
      if (!inserted.rowCount) {
        const raced = await this.findExisting(client, input);
        if (raced) return raced;
        throw new LedgerConflictError('Usage uniqueness conflict could not be resolved');
      }
      await client.query(
        `INSERT INTO ovo_cost_charges
         (id,usage_id,price_card_id,price_card_version,fx_id,fx_version,native_amount_minor,native_currency,amount_paise)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          chargeId,
          usageId,
          card.id,
          card.version,
          fx?.id ?? null,
          fx?.version ?? null,
          nativeAmount,
          card.currency,
          amountPaise,
        ],
      );
      return {
        usageId,
        chargeId,
        state: 'estimated',
        nativeQuantity: input.quantity,
        nativeUnit: input.unit,
        nativeAmountMinor: nativeAmount,
        nativeCurrency: card.currency,
        amountPaise,
        priceCard: input.priceCard,
        fx: input.fx,
      };
    });
  }

  async reconcile(input: ReconcileUsageInput): Promise<ReconciliationResult> {
    validateReconciliation(input);
    parseMinor(input.actualAmountMinor);
    return await transaction(this.pool, async (client) => {
      const charge = await client.query(
        `SELECT c.id,c.amount_paise,c.native_currency,u.state,u.session_id
         FROM ovo_cost_charges c JOIN ovo_cost_native_usage u ON u.id=c.usage_id
         WHERE c.usage_id=$1 AND u.workspace_id=$2 FOR UPDATE OF c,u`,
        [input.usageId, input.workspaceId],
      );
      if (!charge.rowCount) throw new Error('Usage charge not found');
      const prior = await findCorrection(client, input);
      if (prior) return validateCorrection(prior, input);
      const actualPaise = await convertExplicit(
        client,
        input.actualAmountMinor,
        input.currency,
        input.fx,
      );
      const corrections = await client.query(
        'SELECT COALESCE(SUM(delta_paise),0)::text AS total FROM ovo_cost_corrections WHERE usage_id=$1',
        [input.usageId],
      );
      const previous =
        BigInt(String(charge.rows[0]!.amount_paise)) + BigInt(corrections.rows[0]!.total);
      const delta = BigInt(actualPaise) - previous;
      const id = randomUUID();
      const digest = correctionFingerprint(input);
      const inserted = await client.query(
        `INSERT INTO ovo_cost_corrections
         (id,idempotency_key,fingerprint,usage_id,provider_invoice_id,provider_invoice_line_id,
          actual_amount_minor,actual_currency,fx_id,fx_version,delta_paise,effective_amount_paise,occurred_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT DO NOTHING RETURNING id`,
        [
          id,
          input.idempotencyKey,
          digest,
          input.usageId,
          input.providerInvoiceId,
          input.providerInvoiceLineId,
          input.actualAmountMinor,
          input.currency,
          input.fx?.id ?? null,
          input.fx?.version ?? null,
          delta.toString(),
          actualPaise,
          input.occurredAt,
        ],
      );
      if (!inserted.rowCount) {
        const conflict = await findCorrection(client, input);
        if (conflict) return validateCorrection(conflict, input);
        throw new LedgerConflictError(
          'Invoice correction uniqueness conflict could not be resolved',
        );
      }
      await client.query("UPDATE ovo_cost_native_usage SET state='reconciled' WHERE id=$1", [
        input.usageId,
      ]);
      await applySettledBudgetCorrection(client, {
        correctionId: id,
        sessionId: charge.rows[0]!.session_id,
        deltaPaise: delta.toString(),
      });
      return {
        usageId: input.usageId,
        correctionId: id,
        deltaPaise: delta.toString(),
        effectiveAmountPaise: actualPaise,
        state: 'reconciled',
      };
    });
  }

  async summarizeSession(workspaceId: string, sessionId: string): Promise<CostSummary> {
    const result = await this.pool.query(
      `WITH effective AS (
         SELECT u.state,c.amount_paise + COALESCE(SUM(x.delta_paise),0) AS amount
         FROM ovo_cost_native_usage u
         JOIN ovo_cost_charges c ON c.usage_id=u.id
         LEFT JOIN ovo_cost_corrections x ON x.usage_id=u.id
         WHERE u.workspace_id=$1 AND u.session_id=$2
         GROUP BY u.id,c.id
       )
       SELECT COALESCE(SUM(amount) FILTER (WHERE state='estimated'),0)::text AS estimated,
              COALESCE(SUM(amount) FILTER (WHERE state='reconciled'),0)::text AS reconciled,
              COALESCE(SUM(amount),0)::text AS total FROM effective`,
      [workspaceId, sessionId],
    );
    return {
      workspaceId,
      sessionId,
      currency: 'INR',
      estimatedPaise: result.rows[0]!.estimated,
      reconciledPaise: result.rows[0]!.reconciled,
      totalPaise: result.rows[0]!.total,
    };
  }

  private async findExisting(
    client: PoolClient,
    input: RecordUsageInput,
  ): Promise<RecordedUsage | undefined> {
    const result = await client.query<ChargeRow & { fingerprint: string }>(
      `SELECT u.id AS usage_id,c.id AS charge_id,u.state,u.quantity,u.unit,u.fingerprint,
              c.native_amount_minor::text,c.native_currency,c.amount_paise::text,
              c.price_card_id,c.price_card_version,c.fx_id,c.fx_version
       FROM ovo_cost_native_usage u JOIN ovo_cost_charges c ON c.usage_id=u.id
       WHERE u.idempotency_key=$1 OR
             (u.source_event_type=$2 AND u.source_event_id=$3 AND u.source_kind=$4 AND u.unit=$5)
       LIMIT 1`,
      [
        input.idempotencyKey,
        input.sourceEventType,
        input.sourceEventId,
        input.sourceKind,
        input.unit,
      ],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    if (row.fingerprint !== usageFingerprint(input))
      throw new LedgerConflictError('Usage idempotency/provenance conflicts with existing content');
    return mapRecorded(row);
  }
}

async function applySettledBudgetCorrection(
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

function usageFingerprint(input: RecordUsageInput): string {
  const { idempotencyKey: _, usageId: __, ...content } = input;
  return fingerprint(content);
}

function mapRecorded(row: ChargeRow): RecordedUsage {
  return {
    usageId: row.usage_id,
    chargeId: row.charge_id,
    state: row.state,
    nativeQuantity: row.quantity,
    nativeUnit: row.unit,
    nativeAmountMinor: row.native_amount_minor,
    nativeCurrency: row.native_currency,
    amountPaise: row.amount_paise,
    priceCard: { id: row.price_card_id, version: row.price_card_version },
    fx: row.fx_id ? { id: row.fx_id, version: row.fx_version! } : undefined,
  };
}

async function findCorrection(client: PoolClient, input: ReconcileUsageInput) {
  const result = await client.query(
    `SELECT id,idempotency_key,fingerprint,usage_id,delta_paise::text,effective_amount_paise::text
     FROM ovo_cost_corrections
     WHERE idempotency_key=$1 OR (provider_invoice_id=$2 AND provider_invoice_line_id=$3)
     LIMIT 1`,
    [input.idempotencyKey, input.providerInvoiceId, input.providerInvoiceLineId],
  );
  return result.rows[0];
}

function validateCorrection(row: any, input: ReconcileUsageInput): ReconciliationResult {
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

function correctionFingerprint(input: ReconcileUsageInput): string {
  const { idempotencyKey: _, ...content } = input;
  return fingerprint(content);
}
