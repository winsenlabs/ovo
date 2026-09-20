import { randomUUID } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import { transaction } from './database.ts';
import { inputDigest } from './identity.ts';
import type {
  HandoffFallback,
  HandoffProviderPort,
  HandoffProviderResult,
  HandoffRecord,
  HandoffStatus,
  HandoffTarget,
} from './types.ts';

interface HandoffRow extends QueryResultRow {
  id: string;
  operation_id: string;
  input_digest: string;
  session_id: string;
  carrier_call_id: string;
  target: HandoffTarget;
  fallback: HandoffFallback;
  status: HandoffStatus;
  attempt: number;
  request_id: string | null;
  fallback_attempt: number;
  fallback_request_id: string | null;
  provider_receipt_id: string | null;
  retryable: boolean;
  last_error: string | null;
}

const columns = `id, operation_id, input_digest, session_id, carrier_call_id, target, fallback, status, attempt,
  request_id, fallback_attempt, fallback_request_id, provider_receipt_id, retryable, last_error`;

function fromRow(row: HandoffRow): HandoffRecord {
  return {
    id: row.id,
    operationId: row.operation_id,
    sessionId: row.session_id,
    carrierCallId: row.carrier_call_id,
    target: row.target,
    fallback: row.fallback,
    status: row.status,
    attempt: row.attempt,
    requestId: row.request_id ?? undefined,
    fallbackAttempt: row.fallback_attempt,
    fallbackRequestId: row.fallback_request_id ?? undefined,
    providerReceiptId: row.provider_receipt_id ?? undefined,
    retryable: row.retryable,
    lastError: row.last_error ?? undefined,
  };
}

export class HandoffService {
  constructor(
    private readonly pool: Pool,
    private readonly organizationId: string,
    private readonly provider?: HandoffProviderPort,
  ) {}

  get available(): boolean {
    return this.provider !== undefined;
  }

  private requireProvider(): HandoffProviderPort {
    if (!this.provider)
      throw Object.assign(new Error('Handoff carrier is not configured'), {
        code: 'handoff_unavailable',
        statusCode: 503,
      });
    return this.provider;
  }

  async request(input: {
    operationId: string;
    sessionId: string;
    carrierCallId: string;
    target: HandoffTarget;
    fallback: HandoffFallback;
    confirmationRequired: boolean;
  }): Promise<HandoffRecord> {
    this.requireProvider();
    validateTarget(input.target);
    validateFallback(input.fallback);
    if (!input.operationId || input.operationId.length > 200)
      throw new Error('Handoff operationId is invalid');
    if (!input.sessionId || !input.carrierCallId)
      throw new Error('Session and carrier call are required');
    const digest = inputDigest(input);
    const result = await this.pool.query<HandoffRow>(
      `INSERT INTO ovo_ops_handoffs
        (id, organization_id, operation_id, input_digest, session_id, carrier_call_id, target, fallback, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)
       ON CONFLICT (organization_id, operation_id) DO NOTHING RETURNING ${columns}`,
      [
        randomUUID(),
        this.organizationId,
        input.operationId,
        digest,
        input.sessionId,
        input.carrierCallId,
        JSON.stringify(input.target),
        JSON.stringify(input.fallback),
        input.confirmationRequired ? 'awaiting_confirmation' : 'ready',
      ],
    );
    if (result.rows[0]) return fromRow(result.rows[0]);
    const existing = await this.pool.query<HandoffRow>(
      `SELECT ${columns} FROM ovo_ops_handoffs WHERE organization_id = $1 AND operation_id = $2`,
      [this.organizationId, input.operationId],
    );
    if (!existing.rows[0] || existing.rows[0].input_digest !== digest)
      throw new Error('Handoff operationId collision');
    return fromRow(existing.rows[0]);
  }

  async confirm(id: string, accepted: boolean): Promise<HandoffRecord> {
    if (accepted) this.requireProvider();
    const result = await this.pool.query<HandoffRow>(
      `UPDATE ovo_ops_handoffs SET status = $3, updated_at = now()
       WHERE id = $1 AND organization_id = $2 AND status = 'awaiting_confirmation'
       RETURNING ${columns}`,
      [id, this.organizationId, accepted ? 'ready' : 'cancelled'],
    );
    if (result.rows[0]) return fromRow(result.rows[0]);
    return this.get(id);
  }

  async execute(id: string): Promise<HandoffRecord> {
    const provider = this.requireProvider();
    const claimed = await transaction(this.pool, async (client) => {
      const result = await client.query<HandoffRow>(
        `SELECT ${columns} FROM ovo_ops_handoffs
         WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [id, this.organizationId],
      );
      const current = result.rows[0];
      if (!current) throw new Error('Handoff not found');
      if (current.status !== 'ready') return undefined;
      const attempt = current.attempt + 1;
      if (attempt > 3) throw new Error('Handoff retry limit reached');
      const requestId = `${id}:handoff:${attempt}`;
      const updated = await client.query<HandoffRow>(
        `UPDATE ovo_ops_handoffs SET status = 'submitting', attempt = $3, request_id = $4,
           retryable = false, last_error = NULL, updated_at = now()
         WHERE id = $1 AND organization_id = $2 RETURNING ${columns}`,
        [id, this.organizationId, attempt, requestId],
      );
      return fromRow(updated.rows[0]!);
    });
    if (!claimed) return this.get(id);
    let result: HandoffProviderResult;
    try {
      result = await provider.request({
        requestId: claimed.requestId!,
        carrierCallId: claimed.carrierCallId,
        target: claimed.target,
      });
    } catch (error) {
      result = { kind: 'unknown', reason: (error as Error).message };
    }
    const settled = await this.settleProviderResult(claimed, result);
    return result.kind === 'rejected' ? this.executeFallback(settled.id) : settled;
  }

  async reconcile(id: string): Promise<HandoffRecord> {
    const provider = this.requireProvider();
    const current = await this.get(id);
    if (
      current.fallbackRequestId &&
      (current.status === 'fallback_unknown' || current.status === 'fallback_submitting')
    ) {
      const fallback = await provider.reconcile(current.fallbackRequestId);
      if (fallback.kind === 'pending') return current;
      if (fallback.kind === 'not_found')
        return this.updateExact(current, 'fallback_failed', {
          retryable: true,
          lastError: 'Provider certified that the fallback request was not found',
          expectedStatus: current.status,
        });
      if (fallback.kind === 'confirmed')
        return this.updateExact(current, 'fallback_completed', {
          receiptId: fallback.receiptId,
          retryable: false,
          expectedStatus: current.status,
        });
      return this.updateExact(current, 'fallback_failed', {
        retryable: fallback.retryable,
        lastError: fallback.reason,
        expectedStatus: current.status,
      });
    }
    if (!current.requestId || (current.status !== 'unknown' && current.status !== 'submitting'))
      return current;
    const result = await provider.reconcile(current.requestId);
    if (result.kind === 'pending') return current;
    if (result.kind === 'not_found') {
      return this.updateExact(current, 'failed', {
        retryable: true,
        lastError: 'Provider certified that the handoff request was not found',
      });
    }
    const settled = await this.settleProviderResult(current, result);
    return result.kind === 'rejected' ? this.executeFallback(id) : settled;
  }

  async retry(id: string): Promise<HandoffRecord> {
    this.requireProvider();
    const ready = await transaction(this.pool, async (client) => {
      const current = await client.query<HandoffRow>(
        `SELECT ${columns} FROM ovo_ops_handoffs WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [id, this.organizationId],
      );
      const row = current.rows[0];
      if (!row) throw new Error('Handoff not found');
      if (row.status !== 'failed' || !row.retryable || row.attempt >= 3) return false;
      await client.query(
        `UPDATE ovo_ops_handoffs SET status = 'ready', request_id = NULL, updated_at = now() WHERE id = $1`,
        [id],
      );
      return true;
    });
    return ready ? this.execute(id) : this.get(id);
  }

  async retryFallback(id: string): Promise<HandoffRecord> {
    this.requireProvider();
    const current = await this.get(id);
    if (current.status !== 'fallback_failed' || !current.retryable || current.fallbackAttempt >= 3)
      return current;
    return this.executeFallback(id);
  }

  private async settleProviderResult(
    claimed: HandoffRecord,
    result: HandoffProviderResult,
  ): Promise<HandoffRecord> {
    if (result.kind === 'confirmed')
      return this.updateExact(claimed, 'confirmed', {
        receiptId: result.receiptId,
        retryable: false,
      });
    return this.updateExact(claimed, result.kind === 'unknown' ? 'unknown' : 'failed', {
      retryable: result.kind === 'rejected' && result.retryable,
      lastError: result.reason,
    });
  }

  private async executeFallback(id: string): Promise<HandoffRecord> {
    const provider = this.requireProvider();
    const claimed = await this.pool.query<HandoffRow>(
      `UPDATE ovo_ops_handoffs SET status = 'fallback_submitting',
         fallback_attempt = fallback_attempt + 1,
         fallback_request_id = id::text || ':fallback:' || (fallback_attempt + 1)::text,
         updated_at = now()
       WHERE id = $1 AND organization_id = $2
         AND (status = 'failed' OR (status = 'fallback_failed' AND retryable = true))
         AND fallback_attempt < 3 RETURNING ${columns}`,
      [id, this.organizationId],
    );
    if (!claimed.rows[0]) return this.get(id);
    const handoff = fromRow(claimed.rows[0]);
    let result: HandoffProviderResult;
    try {
      result = await provider.fallback({
        requestId: handoff.fallbackRequestId!,
        carrierCallId: handoff.carrierCallId,
        fallback: handoff.fallback,
      });
    } catch (error) {
      result = { kind: 'unknown', reason: (error as Error).message };
    }
    if (result.kind === 'confirmed')
      return this.updateExact(handoff, 'fallback_completed', {
        receiptId: result.receiptId,
        retryable: false,
        expectedStatus: 'fallback_submitting',
      });
    return this.updateExact(
      handoff,
      result.kind === 'unknown' ? 'fallback_unknown' : 'fallback_failed',
      {
        retryable: result.kind === 'rejected' && result.retryable,
        lastError: result.reason,
        expectedStatus: 'fallback_submitting',
      },
    );
  }

  private async updateExact(
    claimed: HandoffRecord,
    status: HandoffStatus,
    input: {
      receiptId?: string;
      retryable: boolean;
      lastError?: string;
      expectedStatus?: HandoffStatus;
    },
  ): Promise<HandoffRecord> {
    const result = await this.pool.query<HandoffRow>(
      `UPDATE ovo_ops_handoffs SET status = $4, provider_receipt_id = $5,
         retryable = $6, last_error = $7, updated_at = now()
       WHERE id = $1 AND organization_id = $2 AND request_id = $3 AND status = $8
       RETURNING ${columns}`,
      [
        claimed.id,
        this.organizationId,
        claimed.requestId,
        status,
        input.receiptId ?? null,
        input.retryable,
        input.lastError ?? null,
        input.expectedStatus ?? (claimed.status === 'unknown' ? 'unknown' : 'submitting'),
      ],
    );
    return result.rows[0] ? fromRow(result.rows[0]) : this.get(claimed.id);
  }

  async get(id: string): Promise<HandoffRecord> {
    const result = await this.pool.query<HandoffRow>(
      `SELECT ${columns} FROM ovo_ops_handoffs WHERE id = $1 AND organization_id = $2`,
      [id, this.organizationId],
    );
    if (!result.rows[0]) throw new Error('Handoff not found');
    return fromRow(result.rows[0]);
  }
}

function validateTarget(target: HandoffTarget): void {
  if (!target.value.trim() || !['phone', 'queue'].includes(target.kind))
    throw new Error('Invalid handoff target');
}

function validateFallback(fallback: HandoffFallback): void {
  if (!fallback.message.trim() || !['resume', 'human', 'end'].includes(fallback.kind))
    throw new Error('Invalid handoff fallback');
  if (fallback.kind === 'human' && !fallback.target.trim())
    throw new Error('Human fallback target is required');
}
