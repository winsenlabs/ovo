import type { QueryResultRow } from 'pg';
import type { InboundAdmission, InboundOverflowPolicy } from './types.ts';

export interface AdmissionRow extends QueryResultRow {
  id: string;
  call_id: string;
  decision: InboundAdmission['kind'];
  slot_id: string | null;
  detail: Record<string, unknown>;
  released_at: Date | null;
  created_at: Date;
}

export interface SlotRow extends QueryResultRow {
  slot_id: string;
  worker_id: string;
  generation: string;
  protected_until: Date;
}

export function validateOverflow(overflow: InboundOverflowPolicy): void {
  if (overflow.kind === 'busy' && !overflow.reason) throw new Error('Busy reason is required');
  if (overflow.kind === 'wait') {
    if (
      !Number.isInteger(overflow.maxWaitMs) ||
      overflow.maxWaitMs < 1_000 ||
      overflow.maxWaitMs > 300_000
    )
      throw new Error('Wait duration is out of range');
    if (!overflow.announcement) throw new Error('Wait announcement is required');
  }
  if ((overflow.kind === 'callback' || overflow.kind === 'human') && !overflow.announcement)
    throw new Error('Overflow announcement is required');
  if (overflow.kind === 'callback' && !overflow.queue)
    throw new Error('Callback queue is required');
  if (overflow.kind === 'human' && !/^\+[1-9]\d{7,14}$/.test(overflow.target))
    throw new Error('Human target must be E.164');
}

export function fromExisting(row: AdmissionRow): InboundAdmission {
  if (row.decision === 'reserved') {
    return {
      kind: 'reserved',
      admissionId: row.id,
      slotId: row.slot_id!,
      workerId: String(row.detail.workerId),
      generation: Number(row.detail.generation),
      protectedUntil: new Date(String(row.detail.protectedUntil)),
    };
  }
  return { admissionId: row.id, ...row.detail } as InboundAdmission;
}
