import type { EngineEvent } from '@winsendotai/ovo-contracts';
import {
  TurnTelemetryCollector,
  type TurnStageSample,
  type TurnTelemetry,
} from '@winsendotai/ovo-plugin-observability';
import type { AudioFormat } from '@winsendotai/ovo-contracts';
import { speechCacheAudio } from './telemetry-carrier-rtt.ts';
import { ReplyWaitClock } from './telemetry-reply-waits.ts';

/** Stages held for turns not yet known: a few utterances asked ahead, never answered, at most. */
const MAX_EARLY_STAGES = 32;

/**
 * OBS-5: a turn's endpoint is the provider's measure, from its word timings, else the engine's (VAD
 * stop to the accepted turn). Scribe has no word timings: on the live calls of 2026-10-07 every
 * turn summary had endpointMs null.
 */
export class WorkerTurnTelemetry extends TurnTelemetryCollector {
  private measured = false;
  /** Wave 8 fix 3: each turn's wait for its first reply audio, part by part (`reply.waits`). */
  private readonly waits: ReplyWaitClock;
  /** Turns the engine has reported (a timing, or the turn's stop), the most recent last. */
  private readonly known = new Set<string>();
  /**
   * Wave 10 (B2): stages of a call asked ahead for an utterance (its `turnId`) that settled before
   * the engine reported that turn. The LLM is asked on the caller's final words while the turn
   * still waits out their silence, so its first token can come first. Counted once it is reported.
   */
  private early: TurnStageSample[] = [];

  constructor(options: {
    includeText: boolean;
    emit: (turn: TurnTelemetry) => void;
    /** Records a stage the worker measured from engine events. */
    stage?: (stage: {
      stage: string;
      turnId: string;
      durationMs: number;
      payload: Record<string, unknown>;
    }) => void;
  }) {
    super(options);
    this.waits = new ReplyWaitClock(({ turnId, firstAudioMs, ...parts }) =>
      options.stage?.({ stage: 'reply.waits', turnId, durationMs: firstAudioMs, payload: parts }),
    );
  }

  /** Wave 9 D7: a line's `speech.cache` event, whose length times the carrier's round trip. */
  speechCache(payload: Record<string, unknown>, format: AudioFormat | undefined): void {
    const audio = speechCacheAudio(payload, format);
    if (audio) this.waits.lineAudio(audio.segmentId, audio.audioMs);
  }

  override engine(event: EngineEvent): void {
    this.waits.engine(event);
    // A reset (Wave 9 D2) is a dropped turn's, not the running turn's start or stop.
    if (event.type === 'user.turn' && event.phase !== 'idle' && event.phase !== 'reset') {
      // As the collector does, a provider measure from before the turn started is not this turn's.
      const engineMs = event.phase === 'stopped' && event.input !== 'dtmf' && event.endpointMs;
      if (!this.measured && typeof engineMs === 'number')
        super.stage({ stage: 'stt.endpoint', durationMs: engineMs, outcome: 'succeeded' });
      this.measured = false;
    }
    super.engine(event);
    const turnId =
      event.type === 'timing' || (event.type === 'user.turn' && event.phase === 'stopped')
        ? event.turnId
        : undefined;
    if (turnId) this.reported(turnId);
  }

  override stage(sample: TurnStageSample): void {
    if (sample.stage === 'stt.endpoint') this.measured = true;
    if (sample.turnId !== undefined && !this.known.has(sample.turnId)) {
      this.early.push(sample);
      if (this.early.length > MAX_EARLY_STAGES) this.early.shift();
      return;
    }
    super.stage(sample);
  }

  private reported(turnId: string): void {
    if (this.known.has(turnId)) return;
    this.known.add(turnId);
    if (this.known.size > 200) this.known.delete(this.known.values().next().value!);
    const held = this.early.filter((sample) => sample.turnId === turnId);
    if (!held.length) return;
    this.early = this.early.filter((sample) => sample.turnId !== turnId);
    for (const sample of held) super.stage(sample);
  }
}
