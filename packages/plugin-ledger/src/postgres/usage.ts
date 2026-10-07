import { randomUUID } from 'node:crypto';
import { priceUsage } from '@winsendotai/ovo-contracts';
import type { Pool, PoolClient } from 'pg';
import { exactPaise, parseMinor } from '../money.ts';
import type {
  CallCostSummary,
  CostSummary,
  RecordedUsage,
  ReconcileUsageInput,
  ReconciliationResult,
  RecordUsageInput,
} from '../types.ts';
import { LedgerConflictError } from '../types.ts';
import { summarizeCall, summarizeSession } from './cost-summary.ts';
import { transaction } from './database.ts';
import { convertExplicit, getPriceCard, priceInInr } from './usage-pricing.ts';
import { validateReconciliation, validateUsage } from './usage-validation.ts';
import { mapRecorded, usageFingerprint, type ChargeRow } from './usage-support.ts';
import {
  applySettledBudgetCorrection,
  correctionFingerprint,
  findCorrection,
  validateCorrection,
} from './usage-reconciliation.ts';

export class UsageRepository {
  constructor(private readonly pool: Pool) {}

  async record(input: RecordUsageInput): Promise<RecordedUsage> {
    validateUsage(input);
    return transaction(this.pool, (client) => this.recordWithClient(client, input));
  }

  async recordWithClient(client: PoolClient, input: RecordUsageInput): Promise<RecordedUsage> {
    validateUsage(input);
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
    // P11: `amountPaise` rounds this one event; the exact value is what call totals add up.
    const exactAmountPaise = exactPaise(input.quantity, card, fx);
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
         (id,usage_id,price_card_id,price_card_version,fx_id,fx_version,native_amount_minor,native_currency,
          amount_paise,exact_amount_paise)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
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
        exactAmountPaise,
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

  summarizeSession(workspaceId: string, sessionId: string): Promise<CostSummary> {
    return summarizeSession(this.pool, workspaceId, sessionId);
  }

  summarizeCall(workspaceId: string, callId: string): Promise<CallCostSummary> {
    return summarizeCall(this.pool, workspaceId, callId);
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
