import type { BoundedSpeechScheduler } from '../scheduler.ts';
import type { ReplyAudibility } from './turn-audibility.ts';

/**
 * The epoch a reply's lines are spoken in. P3: when the reply's first line is ready while its
 * filler is still queued or playing, the filler is cut where it is (the carrier's buffer is flushed
 * between frames) by moving the reply to a fresh epoch, instead of the reply waiting behind the
 * whole filler; its lines wait for that flush. The behaviour keeps the epoch it began with.
 */
export class ReplyEpoch {
  private moving?: Promise<void>;

  constructor(
    public epoch: number,
    private readonly ports: {
      speech: BoundedSpeechScheduler;
      audibility: ReplyAudibility;
      /** The reply moved from `began` to `epoch`; its receipts still belong to `began`. */
      moved: (epoch: number, began: number) => void;
      say: (text: string, epoch: number) => void;
      live: () => boolean;
    },
  ) {}

  /** The reply's first line is ready. */
  first(): void {
    const { speech, audibility } = this.ports;
    if (!audibility.fillerPending(this.epoch)) return;
    const flushed = speech.beginEpoch();
    const began = this.epoch;
    this.epoch = speech.epoch;
    this.ports.moved(this.epoch, began);
    this.moving = flushed.then(() => undefined);
  }

  say(text: string): void {
    if (!this.moving) return this.ports.say(text, this.epoch);
    this.moving = this.moving.then(() => {
      if (this.current()) this.ports.say(text, this.epoch);
    });
  }

  /** True while the call is up and no newer epoch has begun. */
  current(): boolean {
    return this.ports.live() && this.epoch === this.ports.speech.epoch;
  }

  /** Every line said has reached the scheduler. */
  async settled(): Promise<void> {
    await this.moving;
  }
}
