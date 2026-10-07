import type { Clock } from '@winsendotai/ovo-contracts';
import type { SpeechEvidenceConfig } from './config.ts';

/** The VAD's speech runs, oldest first; `end` is unset while one is open. */
type Run = { start: number; end?: number };

/**
 * Whether a transcript is the caller (near the phone, heard by the VAD) or the room: a background
 * talker, a TV, or words an STT invents on line noise, none of which the level-gated VAD hears.
 */
export class SpeechEvidence {
  private runs: Run[] = [];
  /** The VAD has heard this caller: a transcript arrived with VAD speech behind it. */
  private heard = false;
  private cancelRecheck?: () => void;

  constructor(
    private readonly clock: Clock,
    private readonly config: SpeechEvidenceConfig,
    private readonly vad: boolean,
  ) {}

  vadStarted(): void {
    const now = this.clock.now();
    this.runs = this.runs.filter((run) => run.end === undefined || run.end > now - this.window);
    this.runs.push({ start: now });
  }

  vadStopped(): void {
    const open = this.runs.at(-1);
    if (open && open.end === undefined) open.end = this.clock.now();
  }

  /** A transcript arrived; with VAD speech behind it, the VAD is known to hear this caller. */
  transcript(): void {
    if (this.spokenMs() > 0 || this.open) this.heard = true;
  }

  /**
   * 0 when a transcript may barge in now; the wait while an open VAD run accumulates
   * `minSpeechMs`; Infinity when no VAD speech backs it at all.
   */
  bargeInWaitMs(): number {
    if (!this.gating(this.config.bargeIn)) return 0;
    const spoken = this.spokenMs();
    if (!this.open && spoken <= 0) return Infinity;
    const missing = this.config.minSpeechMs - spoken;
    if (missing <= 0) return 0;
    return this.open ? missing : Infinity;
  }

  /** False when, with `bargeIn` on, no VAD speech backs the words heard over the agent. */
  heardNow(): boolean {
    return !this.gating(this.config.bargeIn) || this.open || this.spokenMs() > 0;
  }

  /** False when a transcript in silence has no VAD speech behind it (with `turns` on). */
  startsTurn(): boolean {
    return !this.gating(this.config.turns) || this.open || this.spokenMs() > 0;
  }

  /** Runs `check` once after `ms`, replacing any earlier pending check. */
  recheck(ms: number, check: () => void): void {
    this.cancel();
    this.cancelRecheck = this.clock.setTimeout(() => {
      this.cancelRecheck = undefined;
      check();
    }, ms);
  }

  cancel(): void {
    this.cancelRecheck?.();
    this.cancelRecheck = undefined;
  }

  private get window(): number {
    return this.config.windowMs;
  }

  private get open(): boolean {
    return this.runs.at(-1)?.end === undefined && this.runs.length > 0;
  }

  private gating(enabled: boolean): boolean {
    return enabled && this.vad && this.heard;
  }

  /** VAD speech inside the window ending now. */
  private spokenMs(): number {
    const now = this.clock.now();
    const from = now - this.window;
    return this.runs.reduce(
      (sum, run) => sum + Math.max(0, (run.end ?? now) - Math.max(run.start, from)),
      0,
    );
  }
}
