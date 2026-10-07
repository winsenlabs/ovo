import type { Clock } from '@winsendotai/ovo-contracts';
import type { BoundedSpeechScheduler } from '../scheduler.ts';
import type { VoiceEventBus } from './events.ts';
import { logVoiceEvent } from './log.ts';

/**
 * How long a reply waits on a caller turn that may be noise. Words reach the engine 0.7-1.6 s after
 * the caller starts (Scribe interims, live calls 2026-10-07) and within ~0.45 s of the VAD going
 * quiet (the commit and its final), so a turn with no words by then is a cough, a beep or line noise.
 */
export const REPLY_HOLD = Object.freeze({
  /** No words this long after the VAD went quiet: noise. */
  quietMs: 700,
  /** No words this long after the turn started, even with the VAD still on (steady noise). */
  noWordsMs: 1800,
  /** Never wait on one caller turn longer than this. */
  maxMs: 12_000,
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
  private readonly timers: (() => void)[] = [];
  private cancelQuiet?: () => void;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly clock: Pick<Clock, 'setTimeout'>,
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
      } else if (event.type === 'vad.start') this.quiet();
      else if (event.type === 'vad.stop' && !this.words)
        this.quiet(this.clock.setTimeout(() => this.release('no-words'), this.limits.quietMs));
    });
  }

  get active(): boolean {
    return this.turnId !== undefined;
  }

  started(turnId: string): void {
    this.openTurn = turnId;
    this.consider(turnId);
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

  release(reason: Release): void {
    const turnId = this.turnId;
    if (turnId === undefined) return;
    this.turnId = undefined;
    for (const cancel of this.timers.splice(0)) cancel();
    this.quiet();
    this.speech.release();
    if (reason === 'no-words' || reason === 'timeout')
      logVoiceEvent('warn', 'reply_hold_released', { sessionId: this.sessionId, turnId, reason });
  }

  dispose(): void {
    this.release('closing');
    this.unsubscribe();
  }

  private consider(turnId: string): void {
    if (this.turnId || turnId !== this.openTurn || !this.unheard()) return;
    this.turnId = turnId;
    this.words = false;
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
