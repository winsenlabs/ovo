import type { QueueActivity } from '@winsendotai/ovo-contracts';
import type { TicketRow } from './rows.ts';

export const ACTIVITY_WINDOW_MS = { '24h': 86_400_000, '7d': 7 * 86_400_000 } as const;
/** The newest tickets a queue's activity lists. */
export const ACTIVITY_TICKETS = 50;

const WEBHOOK_FAILURES = new Set(['webhook_rejected', 'webhook_failed']);

/** When a person (or the third party) took the caller: connected, else accepted, else handed on. */
function answeredAt(row: TicketRow): Date | undefined {
  return (
    row.connectedAt ??
    row.acceptedAt ??
    (row.releaseCode === 'handed_off' ? row.releasedAt : undefined)
  );
}

/** Linear interpolation between ranks, as PostgreSQL's `percentile_cont`. */
function percentile(sorted: readonly number[], p: number): number | null {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * p;
  const low = Math.floor(position);
  return sorted[low]! + (position - low) * (sorted[Math.ceil(position)]! - sorted[low]!);
}

const mean = (values: readonly number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

/**
 * What became of the tickets a queue created in the window (R4): how many, how many were taken,
 * dropped or failed, how long callers waited and talked, and the newest rows. A row carries ids,
 * codes and timings: never the caller's number, the summary or the context.
 */
export function queueActivity(
  queueId: string,
  window: QueueActivity['window'],
  rows: readonly TicketRow[],
  now: Date,
): QueueActivity {
  const waits: number[] = [];
  const talks: number[] = [];
  const byOutcome: QueueActivity['stats']['byOutcome'] = {};
  let abandoned = 0;
  let expired = 0;
  let webhookFailed = 0;
  for (const row of rows) {
    const answered = answeredAt(row);
    if (answered) waits.push(Math.max(0, answered.getTime() - row.createdAt.getTime()));
    // Talk time is the desk's: a third party's call is not ours to time once it has left.
    if (row.kind === 'managed' && row.connectedAt && row.releasedAt)
      talks.push(Math.max(0, row.releasedAt.getTime() - row.connectedAt.getTime()));
    if (row.releaseCode === 'abandoned' || row.outcome === 'abandoned') abandoned += 1;
    if (row.status === 'expired') expired += 1;
    if (row.releaseCode && WEBHOOK_FAILURES.has(row.releaseCode)) webhookFailed += 1;
    if (row.outcome) byOutcome[row.outcome] = (byOutcome[row.outcome] ?? 0) + 1;
  }
  waits.sort((a, b) => a - b);
  const newest = [...rows]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
    .slice(0, ACTIVITY_TICKETS);
  return {
    queueId,
    window,
    stats: {
      created: rows.length,
      handled: waits.length,
      abandoned,
      expired,
      webhookFailed,
      avgWaitMs: mean(waits),
      p95WaitMs: percentile(waits, 0.95),
      avgTalkMs: mean(talks),
      byOutcome,
    },
    tickets: newest.map((row) => {
      const waitedUntil = answeredAt(row) ?? row.releasedAt ?? now;
      return {
        id: row.id,
        callId: row.callId,
        status: row.status,
        priority: row.priority,
        ...(row.language ? { language: row.language } : {}),
        createdAt: row.createdAt.toISOString(),
        waitMs: Math.max(0, waitedUntil.getTime() - row.createdAt.getTime()),
        ...(row.releasedAt ? { releasedAt: row.releasedAt.toISOString() } : {}),
        ...(row.releaseCode ? { releaseCode: row.releaseCode } : {}),
        ...(row.outcome ? { outcome: row.outcome } : {}),
        ...(row.assignedOperatorId ? { operatorId: row.assignedOperatorId } : {}),
      };
    }),
  };
}
