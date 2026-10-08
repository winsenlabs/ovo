import type { Clock } from '@winsendotai/ovo-contracts';

/** Words reached the engine up to 1.76 s after the caller started on the live calls (Scribe). */
export const WORDS_LAG_MS = 1800;

/**
 * Wave 8: the STT as a second end signal when the VAD is unreliable. A VAD run that brings no new
 * words for `noiseMs`, from its start or the last words, is the room (café babble, a TV near the
 * phone), not the caller: it is no longer speech that holds a turn open.
 */
export class NoiseWatch {
  private runStartedAt?: number;
  private wordsAt?: number;
  private cancelTimer?: () => void;
  /** The open VAD run has brought no words for `noiseMs`. */
  noise = false;

  constructor(
    private readonly clock: Clock,
    private readonly noiseMs: number,
    private readonly onNoise: () => void,
  ) {}

  vadStarted(): void {
    this.runStartedAt = this.clock.now();
    this.noise = false;
    this.arm();
  }

  vadStopped(): void {
    this.runStartedAt = undefined;
    this.noise = false;
    this.cancel();
  }

  /** The caller's words changed: the VAD run is the caller again. */
  words(): void {
    this.wordsAt = this.clock.now();
    this.noise = false;
    if (this.runStartedAt !== undefined) this.arm();
  }

  cancel(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }

  private arm(): void {
    this.cancel();
    if (!this.noiseMs || this.runStartedAt === undefined) return;
    const from = Math.max(this.runStartedAt, this.wordsAt ?? -Infinity);
    this.cancelTimer = this.clock.setTimeout(
      () => {
        this.cancelTimer = undefined;
        this.noise = true;
        this.onNoise();
      },
      Math.max(0, from + this.noiseMs - this.clock.now()),
    );
  }
}
