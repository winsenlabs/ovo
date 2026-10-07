import type { SpeechOutput } from '@winsendotai/ovo-contracts';
import type { QueueEntry } from './scheduler-settlement.ts';

/** How a held line left the output: `kept` its preparation, or after aborting `playing`. */
export type TakenBack = { kept: boolean; playing?: Promise<unknown> };

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
      // A line still being prepared returns once prepared, keeping its synthesis; only a line the
      // output is playing has to be stopped.
      if (entry.playing)
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

  /**
   * How a held line whose play threw goes back: after the output's play, or with its preparation
   * (a failed one is redone on the next play). An epoch's flush or a timeout during the preparation
   * ends it as any line; undefined then, and for a line not held.
   */
  takenBack(entry: QueueEntry, playing: Promise<unknown> | undefined, aborted: boolean) {
    if (!entry.held) return undefined;
    if (playing) return { kept: false, playing };
    if (!aborted) return { kept: true };
    this.returned(entry, false);
    return undefined;
  }

  /**
   * A held line goes back in the queue unless no longer `current`; else the reason it was not.
   * One the output was playing goes back only once that play has unwound: the output keys its
   * per-line state by segment, and the old play's cleanup would otherwise tear down the replay's
   * (a TypeError in the native output, a silently dropped line in the session's cached one).
   */
  async giveBack(
    entry: QueueEntry,
    taken: TakenBack,
    current: () => boolean,
    timeoutMs: number,
  ): Promise<string | undefined> {
    const unwound = taken.playing ? await settledWithin(taken.playing, timeoutMs) : true;
    if (this.returned(entry, unwound && current(), taken.kept)) return undefined;
    return unwound ? 'stale response epoch' : 'held speech did not stop playing';
  }

  /**
   * A held line has left the output; a `current` one waits in the queue again, in order. One that
   * `kept` its preparation keeps the signal it was prepared under; one that was stopped is
   * prepared afresh.
   */
  returned(entry: QueueEntry, current: boolean, kept = false): boolean {
    entry.held = false;
    entry.prepared = kept;
    this.returning -= 1;
    this.lines.active.delete(entry);
    if (!current) return false;
    if (!kept) entry.controller = new AbortController();
    const queue = this.lines.queue;
    const index = queue.findIndex((queued) => queued.order > entry.order);
    queue.splice(index < 0 ? queue.length : index, 0, entry);
    return true;
  }

  /**
   * The output synthesises the next held lines ahead, as it would while they queue to play. Not
   * while a line is still leaving: an output that orders its carrier writes by preparation (the
   * session's cached output) would then send a later line before it.
   */
  private prepare(epoch: number, count: number): void {
    const prepare = this.lines.output.prepare?.bind(this.lines.output);
    if (!this.holding || this.returning > 0 || !prepare) return;
    for (const entry of this.lines.queue.slice(0, count)) {
      if (entry.prepared || entry.segment.epoch !== epoch) continue;
      entry.prepared = true;
      // swallow-ok: play() prepares the line again and reports any failure there.
      void prepare(entry.segment, entry.controller.signal).catch(() => undefined);
    }
  }
}

/** False when `operation` (an output ignoring an abort) has not settled within `timeoutMs`. */
function settledWithin(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
    const done = () => {
      clearTimeout(timer);
      resolve(true);
    };
    operation.then(done, done);
  });
}
