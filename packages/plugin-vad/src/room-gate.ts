const FRAME_MS = 20;
/** Sound this far under the utterance's loudest moment is no longer the caller's voice. */
const ROOM_BELOW_PEAK_DB = 9;
/** Once the room is found, only sound this close to the caller's loudest moment is the caller. */
const CALLER_BACK_DB = 6;
/** Between utterances the room level sinks 0.5 dB a second, so a softer caller starts again. */
const DECAY_PER_FRAME_DB = (0.5 * FRAME_MS) / 1000;

/**
 * Noise-floor recovery (Wave 8; call 6e1a4e3a turn 9, a café: one utterance held open 9.4 s).
 * Babble near the phone is modulated like speech and within the caller gate, so neither the floor
 * nor the gate ends the caller's utterance under it. The caller's own voice reaches the loudest
 * moment of their utterance again within a second or so; when nothing comes within
 * `ROOM_BELOW_PEAK_DB` of it for `recoverMs`, the caller has stopped and the room is holding the
 * utterance. From then on sound under `CALLER_BACK_DB` of that moment is the room: it ends the
 * utterance and starts none, until the caller is heard at their level again.
 */
export class RoomGate {
  /** The loudest ~100 ms of the current utterance (dB), the caller's level for this utterance. */
  private peakDb = -Infinity;
  /** Utterance time since the level last came within ROOM_BELOW_PEAK_DB of `peakDb`. */
  private quietMs = 0;
  /** Set by a recovery: the caller's level that only the caller reaches, over a louder room. */
  private callerDb?: number;

  constructor(private readonly recoverMs: number | null) {}

  /** `shortDb`: the frame's ~100 ms level; `active`: an utterance is open. True for the room. */
  observe(shortDb: number, active: boolean): boolean {
    if (this.recoverMs === null) return false;
    if (!active) {
      this.peakDb = -Infinity;
      this.quietMs = 0;
      if (this.callerDb === undefined) return false;
      this.callerDb -= DECAY_PER_FRAME_DB;
      if (shortDb < this.callerDb - CALLER_BACK_DB) return true;
      this.callerDb = undefined;
      return false;
    }
    if (this.callerDb !== undefined) return shortDb < this.callerDb - CALLER_BACK_DB;
    if (shortDb >= this.peakDb - ROOM_BELOW_PEAK_DB) {
      this.peakDb = Math.max(this.peakDb, shortDb);
      this.quietMs = 0;
      return false;
    }
    this.quietMs += FRAME_MS;
    if (this.quietMs < this.recoverMs) return false;
    this.callerDb = this.peakDb;
    return true;
  }

  reset(): void {
    this.peakDb = -Infinity;
    this.quietMs = 0;
    this.callerDb = undefined;
  }
}
