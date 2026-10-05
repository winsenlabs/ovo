import type { SttEvent } from '@winsendotai/ovo-contracts';

/** Separate provider drops one call may recover from before the call ends. */
export const MAX_STT_RECOVERIES = 3;

/** A provider failure as STT plugins throw it: a close or error code and whether a retry may help. */
export function sttFailure(error: unknown): { code: string; retryable: boolean } {
  const value = (error && typeof error === 'object' ? error : {}) as {
    code?: unknown;
    retryable?: unknown;
  };
  const code =
    typeof value.code === 'number' || typeof value.code === 'string'
      ? String(value.code)
      : 'write-failed';
  return { code, retryable: value.retryable === true };
}

/**
 * What a reconnect needs from the sessions before it: the audio written since the last final
 * transcript, and where segment IDs and revisions continue.
 */
export class SttRecovery {
  /** Each provider session is a generation; a reconnected one gets distinct segment IDs. */
  generation = 0;
  recoveries = 0;
  private revisionBase = 0;
  private lastRevision = 0;
  private unfinalized: Uint8Array[] = [];
  private unfinalizedBytes = 0;

  constructor(private readonly keepBytes: number) {}

  /** Records a frame on its way to the provider, keeping at most `keepBytes` of them. */
  written(frame: Uint8Array): void {
    this.unfinalized.push(frame);
    this.unfinalizedBytes += frame.length;
    while (this.unfinalizedBytes > this.keepBytes && this.unfinalized.length > 1)
      this.unfinalizedBytes -= this.unfinalized.shift()!.length;
  }

  /** The audio a replacement session must hear again, oldest first. */
  takeUnfinalized(): Uint8Array[] {
    const frames = this.unfinalized;
    this.unfinalized = [];
    this.unfinalizedBytes = 0;
    return frames;
  }

  /** Starts a replacement session's generation. */
  next(): number {
    this.revisionBase = this.lastRevision;
    return ++this.generation;
  }

  /**
   * Providers restart turn numbering and revisions on a new session. Segment IDs from a
   * reconnected session are suffixed so the aggregator does not take them for finished turns.
   */
  remap(event: SttEvent): SttEvent {
    if (
      event.type === 'end-of-turn' ||
      (event.type === 'transcript' && event.segment.stability === 'final')
    )
      this.takeUnfinalized();
    if (event.type !== 'transcript') return event;
    if (!this.generation) {
      this.lastRevision = Math.max(this.lastRevision, event.segment.revision);
      return event;
    }
    const revision = this.revisionBase + event.segment.revision;
    this.lastRevision = Math.max(this.lastRevision, revision);
    return {
      ...event,
      segment: {
        ...event.segment,
        segmentId: `${event.segment.segmentId}~r${this.generation}`,
        revision,
      },
    };
  }
}
