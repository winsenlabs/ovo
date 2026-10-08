const FRAME_MS = 20;
const SILENT_DB = -110;
/** Sound within this of the room's level between utterances is the room, not the caller. */
const NEAR_ROOM_DB = 4;
/**
 * Only a caller this far above the room is told apart from it. Closer, the gate never ends an
 * utterance: a caller trailing off into the room's level is not cut.
 */
const CALLER_OVER_ROOM_DB = 8;
/** Once the room is found, only sound this close to the caller's level is the caller. */
const CALLER_BACK_DB = 6;
/** Between utterances the caller's level sinks 0.5 dB a second, so a softer caller starts again. */
const DECAY_PER_FRAME_DB = (0.5 * FRAME_MS) / 1000;
/** The room's level follows the sound between utterances over ~1 s. */
const ROOM_ALPHA = 1 - Math.exp(-FRAME_MS / 1000);
/**
 * The caller's level follows the utterance's sound above the room over ~0.5 s: a cough, a clatter
 * or a loud first word moves it only for as long as it lasts.
 */
const CALLER_ALPHA = 1 - Math.exp(-FRAME_MS / 500);

/**
 * Noise-floor recovery (Wave 8; call 6e1a4e3a, a café). Babble near the phone is modulated like
 * speech and within the caller gate, so neither the floor nor the gate ends the caller's utterance
 * under it. The room's level is what the line carries between utterances. When an utterance's
 * sound has stayed within `NEAR_ROOM_DB` of it for `recoverMs`, after a caller clearly above it,
 * the caller has stopped and the room is holding the utterance open. From then on sound under
 * `CALLER_BACK_DB` of the caller's level is the room: it ends the utterance and starts none, until
 * the caller is heard at their level again. Speech softer than a loud moment, but above the room,
 * is still the caller's: on a quiet line the gate never ends an utterance.
 */
export class RoomGate {
  /** The level between utterances (dB): the room. */
  private roomDb?: number;
  /** The caller's level in the current utterance (dB), from its sound above the room. */
  private utteranceDb?: number;
  /** Utterance time since its sound was last above the room. */
  private quietMs = 0;
  /** Set by a recovery: the caller's level that only the caller reaches, over a louder room. */
  private callerDb?: number;

  constructor(private readonly recoverMs: number | null) {}

  /** `shortDb`: the frame's ~100 ms level; `active`: an utterance is open. True for the room. */
  observe(shortDb: number, active: boolean): boolean {
    if (this.recoverMs === null) return false;
    const db = Math.max(SILENT_DB, shortDb);
    if (!active) {
      this.utteranceDb = undefined;
      this.quietMs = 0;
      this.roomDb = this.roomDb === undefined ? db : this.roomDb + ROOM_ALPHA * (db - this.roomDb);
      if (this.callerDb === undefined) return false;
      this.callerDb -= DECAY_PER_FRAME_DB;
      if (db < this.callerDb - CALLER_BACK_DB) return true;
      this.callerDb = undefined;
      return false;
    }
    if (this.callerDb !== undefined) return db < this.callerDb - CALLER_BACK_DB;
    if (this.roomDb === undefined || db > this.roomDb + NEAR_ROOM_DB) {
      this.utteranceDb =
        this.utteranceDb === undefined
          ? db
          : this.utteranceDb + CALLER_ALPHA * (db - this.utteranceDb);
      this.quietMs = 0;
      return false;
    }
    this.quietMs += FRAME_MS;
    if (
      this.quietMs < this.recoverMs ||
      this.utteranceDb === undefined ||
      this.utteranceDb < this.roomDb + CALLER_OVER_ROOM_DB
    )
      return false;
    this.callerDb = this.utteranceDb;
    return true;
  }

  reset(): void {
    this.roomDb = this.utteranceDb = this.callerDb = undefined;
    this.quietMs = 0;
  }
}
