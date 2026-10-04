import type { HandoffRecord } from './types.ts';

export function operationsPage<
  T extends { id?: string; phoneNumber?: string; admissionId?: string },
>(items: T[], limit: number) {
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      items.length === limit ? (last?.id ?? last?.phoneNumber ?? last?.admissionId ?? null) : null,
  };
}

export function publicHandoff(record: HandoffRecord) {
  return {
    id: record.id,
    operationId: record.operationId,
    callId: record.sessionId,
    target: record.target,
    fallback: record.fallback,
    status: record.status,
    attempt: record.attempt,
    fallbackAttempt: record.fallbackAttempt,
    retryable: record.retryable,
    providerReceiptId: record.providerReceiptId,
    lastError: record.lastError,
  };
}

export function operationsRequestError(statusCode: number, code: string, message: string): never {
  throw Object.assign(new Error(message), { statusCode, code });
}
