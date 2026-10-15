import type { SegmentHistoryEntry } from './call-memory.ts';
import type { SegmentReason } from './transfer-attempt.ts';
import type { LiveSegment, TransferRun } from './transfer-types.ts';

/** One timeout chain step as `transfer.completed.steps` records it (transfer design 4.5, 7.7). */
export interface ChainStep {
  step: 'target' | 'default' | 'return' | 'human' | 'callback' | 'end' | 'release_default';
  result: 'taken' | 'skipped' | 'failed';
  reason?: string;
}

export type TransferOutcome =
  'connected' | 'fallback' | 'returned' | 'callback' | 'ended' | 'caller_hangup' | 'failed';

/** The `route.segment` event of a segment that has just started (routing design 4.9, R2 4.5). */
export function segmentStarted(
  entry: SegmentHistoryEntry,
  reason: SegmentReason,
  timings: Record<string, number>,
): Record<string, unknown> {
  return {
    ...{ index: entry.index, role: entry.role, agentId: entry.agentId },
    ...{ releaseId: entry.releaseId, reason },
    ...(entry.poolId ? { poolId: entry.poolId } : {}),
    ...(entry.memberId ? { memberId: entry.memberId } : {}),
    ...(entry.transfer !== undefined ? { transfer: entry.transfer } : {}),
    ...(entry.language ? { language: entry.language.slice(0, 12) } : {}),
    ...timings,
  };
}

/** `segment.ended`: how long a segment ran, its caller turns and the usage it reported. */
export function segmentEnded(
  item: LiveSegment,
  ended: 'handoff' | 'call_end' | 'start_failed',
  endReason: string,
  at: number,
): Record<string, unknown> {
  const { entry, segment } = item;
  const usage = segment.stats?.usage;
  return {
    ...{ index: entry.index, role: entry.role, agentId: entry.agentId },
    ...{ releaseId: entry.releaseId },
    ...(entry.language ? { language: entry.language.slice(0, 12) } : {}),
    ...{ ended, endReason: endReason.slice(0, 200) },
    durationMs: ended === 'start_failed' ? 0 : Math.max(0, at - entry.startedAt),
    turns: segment.stats?.turns ?? 0,
    ...(usage && Object.keys(usage).length ? { usage: { ...usage } } : {}),
  };
}

/** `transfer.completed`: ids, codes and timings only; never the caller's words or the summary. */
export function transferCompleted(
  run: TransferRun,
  outcome: TransferOutcome,
  fields: {
    to?: SegmentHistoryEntry;
    holdMs: number;
    gapMs?: number;
    queueMs?: number;
    prepareMs?: number;
    steps: readonly ChainStep[];
    reason?: string;
  },
): Record<string, unknown> {
  const { to } = fields;
  return {
    ...{ transfer: run.transfer, outcome },
    ...(to
      ? {
          toSegment: to.index,
          agentId: to.agentId,
          releaseId: to.releaseId,
          ...(to.poolId ? { poolId: to.poolId } : {}),
          ...(to.memberId ? { memberId: to.memberId } : {}),
        }
      : {}),
    holdMs: Math.max(0, fields.holdMs),
    ...(fields.prepareMs !== undefined ? { prepareMs: fields.prepareMs } : {}),
    ...(fields.queueMs !== undefined ? { queueMs: fields.queueMs } : {}),
    ...(fields.gapMs !== undefined ? { gapMs: fields.gapMs } : {}),
    holdPolicy: run.hold.source,
    steps: fields.steps.slice(0, 8),
    ...(fields.reason ? { reason: fields.reason } : {}),
  };
}
