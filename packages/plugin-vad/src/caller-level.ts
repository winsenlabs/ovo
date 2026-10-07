const FRAME_MS = 20;
/** A second of confident speech before the level is trusted. */
const LEARN_FRAMES = 1000 / FRAME_MS;
/** The level follows the caller's speech with a one-second time constant (in speech frames). */
const LEARN_ALPHA = 1 - Math.exp(-FRAME_MS / 1000);
/** Between utterances the level sinks 0.5 dB a second, so a caller who moves away is relearned. */
const DECAY_PER_FRAME = 10 ** (-(0.5 * FRAME_MS) / 1000 / 10);

const power = (db: number) => 10 ** (db / 10);

/**
 * The caller's own speech level, learned during the call as the RMS of their speech frames (mean
 * power, not mean dB, which sits several dB lower). The caller holds the phone; someone talking
 * across the room reaches its microphone 10–30 dB lower. Only utterances the gate admits are
 * learned from, so a background talker can never teach the gate their level.
 */
export class CallerLevel {
  private power?: number;
  private frames = 0;

  constructor(private readonly gateDb: number | null) {}

  /** `speech`: the frame belongs to an admitted, confident utterance. */
  observe(db: number, speech: boolean, floor: number): void {
    if (speech) {
      this.frames++;
      this.power =
        this.power === undefined ? power(db) : this.power + LEARN_ALPHA * (power(db) - this.power);
    } else if (this.power !== undefined)
      this.power = Math.max(power(floor), this.power * DECAY_PER_FRAME);
  }

  /** The gate is on and a second of the caller's speech has been learned. */
  get learned(): boolean {
    return this.gateDb !== null && this.power !== undefined && this.frames >= LEARN_FRAMES;
  }

  /** True when a frame is more than the gate below the learned caller level: the room. */
  below(db: number): boolean {
    return this.learned && db < 10 * Math.log10(this.power!) - this.gateDb!;
  }

  reset(): void {
    this.power = undefined;
    this.frames = 0;
  }
}
