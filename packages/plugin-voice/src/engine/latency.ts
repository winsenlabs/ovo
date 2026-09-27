import type { Clock, EngineEvent, StageKey } from '@winsendotai/ovo-contracts';

/** Stage durations are deltas from the previous stage, so their sum is elapsed time. */
export class TurnLatency {
  private readonly starts = new Map<string, number>();
  private readonly previous = new Map<string, number>();
  private vadStopAt?: number;
  private finalSttAt?: number;

  constructor(
    private readonly clock: Clock,
    private readonly emit: (event: EngineEvent) => void,
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

  noteFinalStt(): void {
    this.finalSttAt = this.clock.now();
  }

  /** Attribute the wait from VAD stop through final transcript to the accepted turn. */
  accept(turnId: string, speech: boolean): void {
    if (!speech) {
      this.start(turnId);
      return;
    }
    const acceptedAt = this.clock.now();
    const start = this.vadStopAt ?? this.finalSttAt ?? acceptedAt;
    this.starts.set(turnId, start);
    this.previous.set(turnId, start);
    if (this.vadStopAt !== undefined)
      this.stageAt(turnId, 'vad_stop_wait', this.finalSttAt ?? acceptedAt);
    if (this.finalSttAt !== undefined) this.stageAt(turnId, 'stt_finalize', acceptedAt);
    this.vadStopAt = undefined;
    this.finalSttAt = undefined;
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
