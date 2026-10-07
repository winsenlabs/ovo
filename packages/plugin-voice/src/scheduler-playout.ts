import type { QueueEntry } from './scheduler-settlement.ts';

/**
 * How long each line played to the caller, for its receipt's `playedMs`. A line starts playing
 * when its audio reaches the carrier, or, when it was sent while the line before it was still
 * playing, once that line has finished: the carrier plays lines in the order they reach it, so a
 * line queued behind one that never finished never played at all. Lines of another epoch were
 * flushed and never hold a line up.
 */
export class SpeechPlayout {
  /** The line whose audio reached the carrier last. */
  private last?: QueueEntry;
  /** The output reports audio reaching the carrier; until it does, no receipt has `playedMs`. */
  private reports = false;

  constructor(private readonly now: () => number) {}

  /** The line's audio reached the carrier (its first report, not a held line's). */
  sent(entry: QueueEntry): void {
    if (entry.sentAt !== undefined) return;
    this.reports = true;
    entry.sentAt = this.now();
    const before = this.last;
    if (before && before.segment.epoch === entry.segment.epoch && before.endedAt === undefined)
      entry.behind = before;
    this.last = entry;
  }

  /** The line settled; how long it played, or undefined while the output reports no audio. */
  settled(entry: QueueEntry, completed: boolean): number | undefined {
    entry.endedAt = this.now();
    entry.completed = completed;
    const behind = entry.behind;
    entry.behind = undefined;
    if (this.last === entry) this.last = undefined;
    if (!this.reports) return undefined;
    if (entry.sentAt === undefined) return 0;
    if (behind && !behind.completed) return 0;
    const start = Math.max(entry.sentAt, behind?.endedAt ?? entry.sentAt);
    return Math.max(0, entry.endedAt - start);
  }
}
