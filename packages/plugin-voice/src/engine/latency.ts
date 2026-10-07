import type { Clock, EngineEvent, StageKey } from '@winsendotai/ovo-contracts';

/** Stage durations are deltas from the previous stage, so their sum is elapsed time. */
export class TurnLatency {
  private readonly starts = new Map<string, number>();
  private readonly previous = new Map<string, number>();
  private vadStopAt?: number;
  private finalSttAt?: number;
  /** When the caller's words last changed, and to what. */
  private wordsAt?: number;
  private words = '';

  constructor(
    private readonly clock: Clock,
    private readonly emit: (event: EngineEvent) => void,
    /** The VAD's stopMs: the silence it waits out before it reports a stop. */
    private readonly vadHangoverMs = 0,
  ) {}

  start(turnId: string): void {
    this.startElapsed(turnId, 0);
  }

  startElapsed(turnId: string, elapsedMs: number): void {
    if (this.starts.has(turnId)) return;
    const at = this.clock.now();
    const start = Math.max(0, at - Math.max(0, elapsedMs));
    this.starts.set(turnId, start);
    this.previous.set(turnId, start);
  }

  noteVadStop(): void {
    this.vadStopAt = this.clock.now();
  }

  /** A transcript revision; a final that repeats the interim is no new word. */
  noteWords(text: string): void {
    if (text === this.words) return;
    this.words = text;
    this.wordsAt = this.clock.now();
  }

  noteFinalStt(): void {
    this.finalSttAt = this.clock.now();
  }

  /**
   * Attribute the wait from VAD stop through final transcript to the accepted turn. Returns the
   * turn's endpointing wait (OBS-5): from the caller's last voiced audio (the VAD stop, less the
   * silence the VAD waits out before reporting it) to the turn being accepted. A turn the VAD never
   * saw end (noise held it open; the commit fired on a stalled interim) is timed from the last
   * change to its words instead, which the recognizer reports late: a lower bound.
   */
  accept(turnId: string, speech: boolean): number | undefined {
    if (!speech) {
      this.start(turnId);
      return undefined;
    }
    const acceptedAt = this.clock.now();
    const start = this.vadStopAt ?? this.finalSttAt ?? acceptedAt;
    this.starts.set(turnId, start);
    this.previous.set(turnId, start);
    if (this.vadStopAt !== undefined)
      this.stageAt(turnId, 'vad_stop_wait', this.finalSttAt ?? acceptedAt);
    if (this.finalSttAt !== undefined) this.stageAt(turnId, 'stt_finalize', acceptedAt);
    const endpointMs =
      this.vadStopAt !== undefined
        ? acceptedAt - this.vadStopAt + this.vadHangoverMs
        : this.wordsAt !== undefined
          ? acceptedAt - this.wordsAt
          : undefined;
    this.vadStopAt = undefined;
    this.finalSttAt = undefined;
    this.wordsAt = undefined;
    this.words = '';
    return endpointMs === undefined ? undefined : Math.max(0, endpointMs);
  }

  stage(turnId: string, key: StageKey, segmentId?: string): number {
    return this.stageAt(turnId, key, this.clock.now(), segmentId);
  }

  private stageAt(turnId: string, key: StageKey, atMs: number, segmentId?: string): number {
    const before = this.previous.get(turnId) ?? atMs;
    const recordedAt = Math.max(before, atMs);
    const ms = recordedAt - before;
    this.previous.set(turnId, recordedAt);
    this.emit({ type: 'timing', key, turnId, segmentId, atMs: recordedAt, ms });
    return ms;
  }

  total(turnId: string): number {
    const atMs = this.previous.get(turnId) ?? this.clock.now();
    return Math.max(0, atMs - (this.starts.get(turnId) ?? atMs));
  }

  clear(turnId: string): void {
    this.starts.delete(turnId);
    this.previous.delete(turnId);
  }
}
