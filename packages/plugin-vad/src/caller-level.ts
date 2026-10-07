const FRAME_MS = 20;
/** A second of confident speech before the level is trusted. */
const LEARN_FRAMES = 1000 / FRAME_MS;
/** The level follows the caller's speech with a one-second time constant (in speech frames). */
const LEARN_ALPHA = 1 - Math.exp(-FRAME_MS / 1000);
/** Between utterances the level sinks 0.5 dB a second, so a caller who moves away is relearned. */
const DECAY_DB_PER_FRAME = (0.5 * FRAME_MS) / 1000;

/**
 * The caller's own speech level, learned during the call. The caller holds the phone; someone
 * talking across the room reaches its microphone 20–30 dB lower. Only utterances the gate admits
 * are learned from, so a background talker can never teach the gate their level.
 */
export class CallerLevel {
  private level?: number;
  private frames = 0;

  constructor(private readonly gateDb: number | null) {}

  /** `speech`: the frame belongs to an admitted, confident utterance. */
  observe(db: number, speech: boolean, floor: number): void {
    if (speech) {
      this.frames++;
      this.level = this.level === undefined ? db : this.level + LEARN_ALPHA * (db - this.level);
    } else if (this.level !== undefined)
      this.level = Math.max(floor, this.level - DECAY_DB_PER_FRAME);
  }

  /** True when a frame starting an utterance is too far below the learned caller level. */
  farField(db: number): boolean {
    return (
      this.gateDb !== null &&
      this.level !== undefined &&
      this.frames >= LEARN_FRAMES &&
      db < this.level - this.gateDb
    );
  }

  reset(): void {
    this.level = undefined;
    this.frames = 0;
  }
}
