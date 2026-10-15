import { affirmationOnly, callerWords } from '@winsendotai/ovo-contracts';

/**
 * Wave 12: how long after a caller turn ends its reply is taken to be on its way, until a line of
 * it starts. Replies took 1.2–5.1 s to start on call 8cb76efc, searches included; words begun
 * later than this are the caller's own, whatever became of the reply.
 */
export const REPLY_OWED_MS = 8_000;

/**
 * Wave 12: how long after the filler or search line ends words begun are still taken as said to
 * it. Later, with no line of the reply yet, the caller may be asking where it went ("Hello?"): a
 * filler with no reply after it (`reply_filler_only`) must not swallow that.
 */
export const FILLER_TAIL_MS = 1_000;

const QUESTION_MARK = /[?？]/u;

/**
 * Wave 12 (call 8cb76efc turn 20): the reply to the caller's last turn, from that turn's end until
 * a line of it starts. While its filler or search line plays ("One moment.", "Let me look that
 * up."), and just after, it is being composed, and words that add nothing to the turn are no turn
 * of their own (`answers`): the reply on its way answers them. Live, "Please." 1 s after "Yeah, for
 * both these places.", over "Let me look that up.", was queued behind that reply's search and
 * answered after it, so the caller heard "Want to hear more?" and, 2.2 s later, the agent go on
 * unasked ("Sure. In Zagreb…"), 11.8 s after "Please.".
 */
export class OwedReply {
  private owed?: { atMs: number; filler?: { endedAtMs?: number } };

  /** The caller's turn ended at `atMs`. */
  turnEnded(atMs: number): void {
    this.owed = { atMs };
  }

  /** The agent started a line: a filler shows the reply is being composed; any other line is it. */
  agentStarted(filler: boolean): void {
    if (!filler) this.owed = undefined;
    else if (this.owed) this.owed.filler = {};
  }

  /** The agent's line stopped at `atMs`: a filler that ends leaves only `FILLER_TAIL_MS`. */
  agentStopped(atMs: number): void {
    if (this.owed?.filler) this.owed.filler.endedAtMs ??= atMs;
  }

  /**
   * Words begun at `startedAtMs`, while the reply's filler plays or just after, that it answers: a
   * "please" or a yes ("Please.", "Okay.", "Yeah, yeah.", "Yes, please."), or words outside the
   * agent's languages (`offLanguage`). A question ("Okay?", "Hello?"), a greeting, thanks, a no, a
   * goodbye or anything that changes the request is still a turn.
   */
  answers(text: string, startedAtMs: number, offLanguage: () => boolean): boolean {
    const filler = this.owed?.filler;
    if (!this.owed || !filler || startedAtMs - this.owed.atMs > REPLY_OWED_MS) return false;
    if (filler.endedAtMs !== undefined && startedAtMs - filler.endedAtMs > FILLER_TAIL_MS)
      return false;
    if (offLanguage()) return true;
    if (QUESTION_MARK.test(text)) return false;
    const words = callerWords(text);
    return affirmationOnly(text) || (!!words.length && words.every((word) => word === 'please'));
  }
}
