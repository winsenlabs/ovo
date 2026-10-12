import type { Clock } from '@winsendotai/ovo-contracts';
import type { BoundedSpeechScheduler } from '../scheduler.ts';
import type { VoiceEventBus } from './events.ts';
import { logVoiceEvent } from './log.ts';

/**
 * How long a reply waits on a caller turn that may be noise (a cough, a beep, handling rumble). The
 * recogniser ending the utterance with no words says so at once (Scribe answers the commit ~0.35 s
 * after it); these bound the wait without it. Words reach the engine 0.7-1.6 s after the caller
 * starts (Scribe interims, live calls 2026-10-07), and a final comes within the commit's silence
 * (50 ms today, ~450 ms proposed for P2) plus ~0.4 s of the VAD going quiet.
 */
export const REPLY_HOLD = Object.freeze({
  /** No words this long after the VAD went quiet: noise. */
  quietMs: 1200,
  /** No words this long after the turn started, even with the VAD still on (steady noise). */
  noWordsMs: 1800,
  /** Never wait on one caller turn longer than this. */
  maxMs: 12_000,
  /**
   * Wave 8b: the reply to words that trailed off (the turn ended on the detector's `hold`: "…to
   * the 5th.", "Budapest, Vienna,") waits this long after the turn for the caller to go on. Its
   * LLM call runs meanwhile, so a reply that takes as long plays no later. In call e8a43f65 "Of
   * January." came 1.3 s after such a turn ended.
   */
  trailingMs: 2_000,
});

type Release = 'stopped' | 'reset' | 'no-words' | 'timeout' | 'closing';

/**
 * P1: the caller started a new turn before hearing any of the reply to their last words (the
 * live talk-over: a pause mid-sentence ended the turn, and its reply started over the rest of the
 * sentence). The reply's speech is held instead of playing over them, from the turn's start (the
 * VAD's or its first words) until it ends: stopped, after AGT-10 has merged or superseded the
 * reply, or dropped as a backchannel or muted, when the reply plays at once. A turn that brings
 * no words (noise) releases it early, and none holds it longer than `maxMs`.
 */
export class ReplyHold {
  /** The caller turn the detector has open, from turn.started to its stop or reset. */
  private openTurn?: string;
  /** The turn holding the reply. */
  private turnId?: string;
  private words = false;
  /** When the hold began, and when the VAD last went quiet during it, for the release log. */
  private heldAt = 0;
  private quietAt?: number;
  private readonly timers: (() => void)[] = [];
  private cancelQuiet?: () => void;
  /** Ends the wait after words that trailed off (`trailedOff`). */
  private cancelTrailing?: () => void;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly clock: Pick<Clock, 'setTimeout' | 'now'>,
    private readonly speech: Pick<BoundedSpeechScheduler, 'hold' | 'release'>,
    events: VoiceEventBus,
    /** True while the caller is owed a reply they have not heard any of. */
    private readonly unheard: () => boolean,
    private readonly sessionId: string,
    private readonly limits: typeof REPLY_HOLD = REPLY_HOLD,
  ) {
    this.unsubscribe = events.onEvent((event) => {
      if (!this.turnId) return;
      if (event.type === 'stt' && event.event.type === 'transcript') {
        if (event.event.segment.text.trim()) this.heard(this.turnId);
      } else if (event.type === 'stt' && event.event.type === 'end-of-turn') {
        // The recogniser closed the utterance with nothing in it.
        if (!event.event.eager && !this.words) this.release('no-words');
      } else if (event.type === 'vad.start') {
        this.quietAt = undefined;
        this.quiet();
      } else if (event.type === 'vad.stop') {
        this.quietAt = this.clock.now();
        if (!this.words)
          this.quiet(this.clock.setTimeout(() => this.release('no-words'), this.limits.quietMs));
      }
    });
  }

  get active(): boolean {
    return this.turnId !== undefined;
  }

  started(turnId: string): void {
    this.openTurn = turnId;
    // Held a microtask later: a turn the detector drops in the same tick (muted, while a tool runs
    // or a disclosure plays) holds nothing, so the reply's synthesis is not stopped for it.
    queueMicrotask(() => this.consider(turnId));
  }

  /** The turn's words so far: it is speech, and a reply its VAD start did not hold is held now. */
  partial(turnId: string): void {
    this.consider(turnId);
    this.heard(turnId);
  }

  ended(turnId: string, reason: 'stopped' | 'reset'): void {
    if (turnId === this.openTurn) this.openTurn = undefined;
    this.release(reason);
  }

  /**
   * Wave 8b: the caller's turn ended on words that trailed off. Its reply waits `trailingMs` for
   * them to go on (a turn they start then holds it as any other), then plays.
   */
  trailedOff(): void {
    if (this.turnId || !this.unheard()) return;
    this.cancelTrailing?.();
    this.speech.hold();
    this.cancelTrailing = this.clock.setTimeout(() => {
      this.cancelTrailing = undefined;
      if (!this.turnId) this.speech.release();
    }, this.limits.trailingMs);
  }

  release(reason: Release): void {
    // Closing: a turn that started this tick holds nothing either.
    if (reason === 'closing') this.openTurn = undefined;
    const trailing = this.cancelTrailing;
    this.cancelTrailing = undefined;
    trailing?.();
    const turnId = this.turnId;
    if (turnId === undefined) {
      if (trailing) this.speech.release();
      return;
    }
    this.turnId = undefined;
    for (const cancel of this.timers.splice(0)) cancel();
    this.quiet();
    this.speech.release();
    // Wave 8 fix 3: how long the reply waited, and how long after the caller went quiet it went.
    const now = this.clock.now();
    const fields = {
      sessionId: this.sessionId,
      turnId,
      reason,
      heldMs: now - this.heldAt,
      ...(this.quietAt === undefined ? {} : { quietMs: now - this.quietAt }),
    };
    const level = reason === 'no-words' || reason === 'timeout' ? 'warn' : 'info';
    logVoiceEvent(level, 'reply_hold_released', fields);
  }

  dispose(): void {
    this.release('closing');
    this.unsubscribe();
  }

  private consider(turnId: string): void {
    if (this.turnId || turnId !== this.openTurn || !this.unheard()) return;
    this.turnId = turnId;
    this.words = false;
    this.heldAt = this.clock.now();
    this.quietAt = undefined;
    this.speech.hold();
    this.timers.push(
      this.clock.setTimeout(() => this.release('timeout'), this.limits.maxMs),
      this.clock.setTimeout(() => {
        if (!this.words) this.release('no-words');
      }, this.limits.noWordsMs),
    );
  }

  /** The caller is saying something: the turn will end with words or as a backchannel. */
  private heard(turnId: string): void {
    if (turnId !== this.turnId) return;
    this.words = true;
    this.quiet();
  }

  /** Replaces the no-words timer that runs while the VAD is quiet. */
  private quiet(cancel?: () => void): void {
    this.cancelQuiet?.();
    this.cancelQuiet = cancel;
  }
}
