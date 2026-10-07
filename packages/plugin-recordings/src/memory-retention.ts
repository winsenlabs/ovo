import { ABANDONED_FAILURE } from './repository.ts';
import type {
  LiveRecording,
  RecordingSegment,
  RecordingTombstone,
  RetentionCursor,
  RetentionPage,
} from './types.ts';

/** The states of an artifact whose capture has not finalized it. */
const UNFINALIZED: readonly LiveRecording['state'][] = [
  'starting',
  'active',
  'paused',
  'finalizing',
];

/** `MemoryRecordingRepository.pageExpired` over its rows: expired, not tombstoned, after `cursor`. */
export function expiredPage(
  rows: Iterable<LiveRecording>,
  tombstoned: (id: string) => boolean,
  now: string,
  cursor: RetentionCursor | undefined,
  limit: number,
): RetentionPage {
  const items = [...rows]
    .filter((item) => item.expiresAt <= now && !tombstoned(item.id))
    .filter(
      (item) =>
        !cursor ||
        item.expiresAt > cursor.expiresAt ||
        (item.expiresAt === cursor.expiresAt && item.id > cursor.artifactId),
    )
    .sort((a, b) => compare(a.expiresAt, b.expiresAt) || compare(a.id, b.id))
    .slice(0, Math.min(100, Math.max(1, limit)));
  const last = items.at(-1);
  return {
    items: structuredClone(items),
    nextCursor:
      items.length === limit && last
        ? { expiresAt: last.expiresAt, artifactId: last.id }
        : undefined,
  };
}

/**
 * `MemoryRecordingRepository.recoverAbandoned` over its rows: the oldest unfinalized artifacts
 * created before `createdBefore` become `partial` when a segment is available, else `failed`.
 */
export function settleAbandoned(
  recordings: Map<string, LiveRecording>,
  segments: ReadonlyMap<string, readonly RecordingSegment[]>,
  tombstones: ReadonlyMap<string, RecordingTombstone>,
  input: { createdBefore: string; at: string; limit: number },
): number {
  const abandoned = [...recordings.values()]
    .filter(
      (item) =>
        UNFINALIZED.includes(item.state) &&
        item.createdAt < input.createdBefore &&
        !tombstones.has(item.id),
    )
    .sort((a, b) => compare(a.createdAt, b.createdAt) || compare(a.id, b.id))
    .slice(0, Math.min(100, Math.max(1, input.limit)));
  for (const item of abandoned) {
    const held = (segments.get(item.id) ?? []).some((segment) => segment.state === 'available');
    recordings.set(item.id, {
      ...item,
      state: held ? 'partial' : 'failed',
      updatedAt: input.at,
      failure: ABANDONED_FAILURE,
    });
  }
  return abandoned.length;
}

export function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
