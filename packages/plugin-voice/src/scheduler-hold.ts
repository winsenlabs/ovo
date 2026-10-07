import type { SpeechOutput } from '@winsendotai/ovo-contracts';
import type { QueueEntry } from './scheduler-settlement.ts';

/**
 * P1: the caller started talking before hearing any of the reply. While held no line starts, and
 * a line already playing whose audio has not reached the carrier is taken back, to play on release
 * in its speaking order. Audio already sent (a filler clip) plays on. Held lines are prepared
 * meanwhile, so a release plays at once; a new epoch flushes them as it flushes any line.
 */
export class SpeechHold {
  holding = false;
  /** Held lines still leaving the output; the queue waits for them to keep its order. */
  private returning = 0;
  /** The output reports audio reaching the carrier ('sent'); until then a started line is heard. */
  private reportsSent = false;

  constructor(
    private readonly lines: {
      queue: QueueEntry[];
      active: Map<QueueEntry, AbortController>;
      output: SpeechOutput;
      /** Playback in flight, to wait on. */
      playing: () => Promise<unknown>[];
    },
  ) {}

  /**
   * The next line waits (held, or a held line is still leaving the output) and is prepared rather
   * than played. A stale line is not held: it is flushed.
   */
  next(epoch: number, prepare: number): boolean {
    const waiting = this.holding || this.returning > 0;
    if (this.lines.queue[0]?.segment.epoch !== epoch || !waiting) return false;
    this.prepare(epoch, prepare);
    return true;
  }

  hold(epoch: number): void {
    this.holding = true;
    // Without 'sent' reports a started line counts as heard, so there is nothing to take back.
    if (!this.reportsSent) return;
    for (const [entry, controller] of this.lines.active) {
      if (entry.sent || entry.held || entry.segment.epoch !== epoch) continue;
      entry.held = true;
      this.returning += 1;
      controller.abort(new DOMException('speech held for the caller', 'AbortError'));
    }
  }

  /** Ends the hold; true when it was held. */
  release(): boolean {
    const held = this.holding;
    this.holding = false;
    return held;
  }

  async settled(): Promise<void> {
    while ([...this.lines.active.keys()].some((entry) => !entry.held)) {
      const playing = this.lines.playing();
      if (!playing.length) return;
      await Promise.race(playing);
    }
  }

  /** A playback report to record; a held line's late report is not audio the caller will hear. */
  reported(entry: QueueEntry, phase: 'sent' | 'acknowledged'): boolean {
    if (entry.held) return false;
    if (phase === 'sent') entry.sent = this.reportsSent = true;
    return true;
  }

  /** A held line has left the output; a `current` one waits in the queue again, in order. */
  returned(entry: QueueEntry, current: boolean): boolean {
    entry.held = entry.prepared = false;
    this.returning -= 1;
    this.lines.active.delete(entry);
    if (!current) return false;
    entry.controller = new AbortController();
    const queue = this.lines.queue;
    const index = queue.findIndex((queued) => queued.order > entry.order);
    queue.splice(index < 0 ? queue.length : index, 0, entry);
    return true;
  }

  /** The output synthesises the next held lines ahead, as it would while they queue to play. */
  private prepare(epoch: number, count: number): void {
    const prepare = this.lines.output.prepare?.bind(this.lines.output);
    if (!this.holding || !prepare) return;
    for (const entry of this.lines.queue.slice(0, count)) {
      if (entry.prepared || entry.segment.epoch !== epoch) continue;
      entry.prepared = true;
      // swallow-ok: play() prepares the line again and reports any failure there.
      void prepare(entry.segment, entry.controller.signal).catch(() => undefined);
    }
  }
}
