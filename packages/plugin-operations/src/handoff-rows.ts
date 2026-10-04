import type { QueryResultRow } from 'pg';
import type { HandoffFallback, HandoffRecord, HandoffStatus, HandoffTarget } from './types.ts';

export interface HandoffRow extends QueryResultRow {
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

export const columns = `id, operation_id, input_digest, session_id, carrier_call_id, target, fallback, status, attempt,
  request_id, fallback_attempt, fallback_request_id, provider_receipt_id, retryable, last_error`;

export function fromRow(row: HandoffRow): HandoffRecord {
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
