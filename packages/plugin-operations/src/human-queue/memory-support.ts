import type { TicketRow } from './rows.ts';
import type { TicketFilter } from './store.ts';

/** A controllable clock for unit tests. */
export class MemoryClock {
  constructor(private current = new Date('2026-10-15T09:00:00.000Z')) {}
  now = (): Date => new Date(this.current);
  set(date: Date | string): void {
    this.current = new Date(date);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export function matches(row: TicketRow, f: TicketFilter): boolean {
  return (
    (f.queueId === undefined || row.queueId === f.queueId) &&
    (f.statuses === undefined || f.statuses.includes(row.status)) &&
    (f.kind === undefined || row.kind === f.kind) &&
    (f.assignedTo === undefined || row.assignedOperatorId === f.assignedTo) &&
    (f.callId === undefined || row.callId === f.callId) &&
    (f.idempotencyKey === undefined || row.idempotencyKey === f.idempotencyKey) &&
    (f.sinceChangeId === undefined || row.changeId > f.sinceChangeId) &&
    (f.releasedSince === undefined ||
      (row.releasedAt !== undefined && row.releasedAt >= f.releasedSince)) &&
    (f.scrubDue === undefined ||
      (row.context !== undefined &&
        row.contextExpiresAt !== undefined &&
        row.contextExpiresAt <= f.scrubDue))
  );
}

export function applyPatch<T extends object>(row: T, patch: object): T {
  const next = { ...row } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  }
  return next as T;
}
