import {
  acknowledgementOnly,
  classifyConfirmation,
  endsConversation,
} from '@winsendotai/ovo-contracts';

/**
 * Wave 12: how long after a caller turn ends its reply is taken to be on its way, until a line of
 * it starts. Replies took 1.2–5.1 s to start on call 8cb76efc, searches included; words begun
 * later than this are the caller's own, whatever became of the reply.
 */
export const REPLY_OWED_MS = 8_000;

/**
 * Wave 12 (call 8cb76efc turn 20): the reply to the caller's last turn, from that turn's end until
 * a line of it starts. Once its filler or search line has started ("One moment.", "Let me look
 * that up."), it is being composed, and words that add nothing to the turn are no turn of their
 * own (`answers`): the reply on its way answers them. Live, "Please." 1 s after "Yeah, for both
 * these places.", over "Let me look that up.", was queued behind that reply's search and answered
 * after it, so the caller heard "Want to hear more?" and, 2.2 s later, the agent go on unasked
 * ("Sure. In Zagreb…"), 11.8 s after "Please.".
 */
export class OwedReply {
  private owed?: { atMs: number; composing: boolean };

  /** The caller's turn ended at `atMs`. */
  turnEnded(atMs: number): void {
    this.owed = { atMs, composing: false };
  }

  /** The agent started a line: a filler shows the reply is being composed; any other line is it. */
  agentStarted(filler: boolean): void {
    if (!filler) this.owed = undefined;
    else if (this.owed) this.owed.composing = true;
  }

  /**
   * Words begun at `startedAtMs`, while the reply is composed, that it answers: a "please" or a yes
   * ("Please.", "Okay.", "Yeah, yeah."), or words outside the agent's languages (`offLanguage`). A
   * no, a goodbye or anything else that changes the request is still a turn.
   */
  answers(text: string, startedAtMs: number, offLanguage: () => boolean): boolean {
    const owed = this.owed;
    if (!owed?.composing || startedAtMs - owed.atMs > REPLY_OWED_MS) return false;
    if (offLanguage()) return true;
    return (
      acknowledgementOnly(text) && classifyConfirmation(text) !== 'no' && !endsConversation(text)
    );
  }
}
