/** The human handoff (AGT-15): targets, fallbacks, provider results and the durable record. */
export type HandoffTarget = { kind: 'phone'; value: string } | { kind: 'queue'; value: string };
export type HandoffFallback =
  | { kind: 'resume'; message: string }
  | { kind: 'human'; target: string; message: string }
  | { kind: 'end'; message: string };

export type HandoffProviderResult =
  | { kind: 'confirmed'; receiptId: string }
  | { kind: 'rejected'; reason: string; retryable: boolean }
  | { kind: 'unknown'; reason: string };

export type HandoffReconciliation =
  | { kind: 'confirmed'; receiptId: string }
  | { kind: 'rejected'; reason: string; retryable: boolean }
  | { kind: 'pending' }
  | { kind: 'not_found' };

export interface HandoffProviderPort {
  request(input: {
    requestId: string;
    carrierCallId: string;
    target: HandoffTarget;
  }): Promise<HandoffProviderResult>;
  reconcile(requestId: string): Promise<HandoffReconciliation>;
  fallback(input: {
    requestId: string;
    carrierCallId: string;
    fallback: HandoffFallback;
  }): Promise<HandoffProviderResult>;
}

export type HandoffStatus =
  | 'awaiting_confirmation'
  | 'ready'
  | 'submitting'
  | 'confirmed'
  | 'failed'
  | 'unknown'
  | 'cancelled'
  | 'fallback_submitting'
  | 'fallback_completed'
  | 'fallback_failed'
  | 'fallback_unknown';

export interface HandoffRecord {
  id: string;
  operationId: string;
  sessionId: string;
  carrierCallId: string;
  target: HandoffTarget;
  fallback: HandoffFallback;
  status: HandoffStatus;
  attempt: number;
  requestId?: string;
  fallbackAttempt: number;
  fallbackRequestId?: string;
  providerReceiptId?: string;
  retryable: boolean;
  lastError?: string;
}
