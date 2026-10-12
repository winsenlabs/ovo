import type { Clock, SpeechEvidence, TurnDecision } from '@winsendotai/ovo-contracts';
import type { VoiceEventBus } from './events.ts';

/**
 * Call-3 #8: after a long answer the caller gets longer to take it in before an idle prompt. On
 * call 6e1a4e3a "Are you still there?" came 10 s after a ~30 s answer, while the caller was still
 * digesting it. A short answer or a question adds nothing.
 */
export const IDLE_AFTER_ANSWER = Object.freeze({
  /** An answer this long or shorter adds nothing. */
  freeChars: 60,
  /** Each character past that adds this much: about 0.6 of the time it took to say. */
  perCharMs: 40,
  maxExtraMs: 10_000,
});

type Idle = Extract<TurnDecision, { type: 'idle' }>;

/**
 * The agent's last answer: the lines of its newest reply that played to the end, and when the last
 * of them did. Filler lines (`acknowledgment`) are no answer.
 */
export class IdlePacing {
  private epoch = -1;
  private chars = 0;
  private endedAt?: number;

  constructor(
    private readonly clock: Pick<Clock, 'now'>,
    private readonly limits: typeof IDLE_AFTER_ANSWER = IDLE_AFTER_ANSWER,
  ) {}

  /** Feed every scheduler evidence record. */
  observe(evidence: SpeechEvidence): void {
    if (evidence.phase !== 'completed' || evidence.kind === 'acknowledgment') return;
    if (evidence.epoch !== this.epoch) {
      this.epoch = evidence.epoch;
      this.chars = 0;
    }
    this.chars += evidence.text.length;
    this.endedAt = this.clock.now();
  }

  /** The answer the extra silence is for: its epoch, or undefined before any. */
  get answer(): number | undefined {
    return this.endedAt === undefined ? undefined : this.epoch;
  }

  /** The extra silence the last answer earns, on top of the idle timeout. */
  extraMs(): number {
    const { freeChars, perCharMs, maxExtraMs } = this.limits;
    return Math.min(maxExtraMs, Math.max(0, this.chars - freeChars) * perCharMs);
  }

  /** What is left of that extra silence now: timed from the end of the answer's playback. */
  remainingMs(): number {
    if (this.endedAt === undefined) return 0;
    return Math.max(0, this.endedAt + this.extraMs() - this.clock.now());
  }
}

/**
 * The turn detector's idle prompts (for a behaviour without its own idle policy), paced by the
 * last answer: the detector times its silence from the agent stopping, so its first prompt after a
 * long answer is put off by the answer's extra silence, and dropped if the caller is heard in the
 * meantime. A prompt dropped that way is still owed: the detector's next silence says it instead
 * of ending the call without asking.
 */
export class DetectorIdle {
  private cancelTimer?: () => void;
  private deferredFor?: number;
  private owed?: Idle;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly clock: Pick<Clock, 'setTimeout'>,
    events: VoiceEventBus,
    private readonly pacing: IdlePacing,
    /** True when no caller turn is open, no reply runs and nothing is playing. */
    private readonly quiet: () => boolean,
    private readonly run: (decision: Idle) => void,
  ) {
    this.unsubscribe = events.onEvent((event) => {
      if (
        event.type === 'vad.start' ||
        event.type === 'dtmf' ||
        (event.type === 'stt' &&
          event.event.type === 'transcript' &&
          event.event.segment.text.trim())
      )
        this.cancel();
    });
  }

  idle(decision: Idle): void {
    this.cancel();
    if (!this.quiet()) {
      // The agent is still speaking (an early stop) or the caller is: no prompt now.
      if (!decision.final) this.owed ??= decision;
      return;
    }
    const answer = this.pacing.answer;
    const waitMs = answer !== this.deferredFor ? this.pacing.extraMs() : 0;
    if (waitMs > 0) {
      this.deferredFor = answer;
      if (!decision.final) this.owed ??= decision;
      this.cancelTimer = this.clock.setTimeout(() => {
        this.cancelTimer = undefined;
        if (this.quiet()) this.say(decision);
      }, waitMs);
      return;
    }
    this.say(decision);
  }

  /** The caller spoke: nothing is owed any more. */
  answered(): void {
    this.cancel();
    this.owed = undefined;
  }

  cancel(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }

  dispose(): void {
    this.cancel();
    this.unsubscribe();
  }

  private say(decision: Idle): void {
    const owed = this.owed;
    this.owed = undefined;
    this.run(decision.final && owed ? owed : decision);
  }
}
