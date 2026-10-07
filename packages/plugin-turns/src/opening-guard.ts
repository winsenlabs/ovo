import { normalizeForMatch, type Clock } from '@winsendotai/ovo-contracts';
import type { OpeningConfig } from './config.ts';

/**
 * N8: the call's opening (the agent's first speech, before the caller has had a turn) is not cut
 * by the first sound on the line. For `protectMs` from its first audio nothing barges in on it: a
 * cough, line noise, an STT's first garbled guess ("Знаете, что?" 2.3 s into a live greeting).
 * After that, with `confirmWords`, only words the STT confirms do: two revisions of the
 * transcript that start with the same word. Words that do not barge in are not lost: the caller's
 * turn goes on, and is answered once the opening ends.
 */
export class OpeningGuard {
  /** When the opening's audio started; unset before it and once it is over. */
  private startedAt?: number;
  /** The opening has ended, or the caller has had a turn: nothing is protected any more. */
  private over = false;
  private first?: string;
  private confirmed = false;
  private cancelRecheck?: () => void;

  constructor(
    private readonly clock: Clock,
    private readonly config: OpeningConfig,
  ) {}

  /** The agent started speaking; its first speech before any caller turn is the opening. */
  botStarted(atMs: number): void {
    if (!this.over && this.startedAt === undefined) this.startedAt = atMs;
  }

  /** The opening stopped, or the caller had a turn. */
  end(): void {
    this.over = true;
    this.startedAt = undefined;
    this.clear();
  }

  /** A revision of the words of the caller's turn over the opening. */
  words(view: string): void {
    if (this.startedAt === undefined || this.confirmed) return;
    const first = normalizeForMatch(view).split(' ')[0];
    if (!first) return;
    if (first === this.first) this.confirmed = true;
    this.first = first;
  }

  /** How long a barge-in on the opening must wait: 0 for none, Infinity for confirmed words. */
  waitMs(): number {
    if (this.startedAt === undefined) return 0;
    const left = this.config.protectMs - (this.clock.now() - this.startedAt);
    if (left > 0) return left;
    return this.config.confirmWords && !this.confirmed ? Infinity : 0;
  }

  /** Runs `check` once the protected window has passed, replacing any earlier pending check. */
  recheck(ms: number, check: () => void): void {
    this.cancelRecheck?.();
    this.cancelRecheck = this.clock.setTimeout(() => {
      this.cancelRecheck = undefined;
      check();
    }, ms);
  }

  /** The caller's turn ended: the next one confirms its own words. */
  clear(): void {
    this.cancelRecheck?.();
    this.cancelRecheck = undefined;
    this.first = undefined;
    this.confirmed = false;
  }
}
