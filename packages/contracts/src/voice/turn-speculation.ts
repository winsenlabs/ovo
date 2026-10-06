/** The caller's utterance in progress, as the turn detector hears it (LAT-4). */
export interface PartialUtterance {
  turnId: string;
  text: string;
  /** Every word comes from a final STT segment, so the STT will not revise it. */
  stable: boolean;
}

/** The text the engine is about to answer for a caller turn. */
export interface FinalUtterance {
  turnId: string;
  /** Exactly the `input` the following `respond`/`respondStream` call receives. */
  text: string;
  /** True when it joins an earlier utterance that was superseded before it was answered (AGT-10). */
  merged: boolean;
}

/**
 * Optional hooks a behaviour implements to work ahead of the caller (LAT-4). The native engine's
 * turn driver reads them from the behaviour structurally; every call is synchronous, must be cheap
 * and must not throw (a throw is logged and ignored). Start any slow work detached and key it by
 * `turnId`.
 *
 * For one caller utterance, under the turn detector's id:
 * - `prepare` on each new revision while the caller speaks;
 * - `finalize` when its reply starts: `respond`/`respondStream` follows on the same tick, with
 *   exactly `final.text` as its input;
 * - `discard(id, 'reset')` instead, when the detector drops the speech (a backchannel, muted);
 * - `discard(id, 'superseded')` when a newer utterance takes the words over before the caller has
 *   heard any answer (whether or not `finalize` ran): they come back in the newer turn's
 *   `finalize` with `merged: true`. Nothing prepared for a discarded id may be used.
 * A reply cut off while only a filler had played can be finalised again, under the same id, when
 * the engine runs it again.
 */
export interface TurnSpeculation {
  prepare?(partial: PartialUtterance): void;
  finalize?(final: FinalUtterance): void;
  /**
   * The utterance will not be answered under this id: a backchannel or muted speech (`reset`), or
   * a newer utterance superseded or absorbed it (`superseded`).
   */
  discard?(turnId: string, reason: 'reset' | 'superseded'): void;
}
