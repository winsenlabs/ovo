import type { EngineEvent } from '@winsendotai/ovo-contracts';
import {
  TurnTelemetryCollector,
  type TurnStageSample,
} from '@winsendotai/ovo-plugin-observability';

/**
 * OBS-5: a turn's endpoint is the provider's measure, from its word timings, else the engine's (VAD
 * stop to the accepted turn). Scribe has no word timings: on the live calls of 2026-10-07 every
 * turn summary had endpointMs null.
 */
export class WorkerTurnTelemetry extends TurnTelemetryCollector {
  private measured = false;

  override engine(event: EngineEvent): void {
    if (event.type === 'user.turn' && event.phase !== 'idle') {
      // As the collector does, a provider measure from before the turn started is not this turn's.
      const engineMs = event.phase === 'stopped' && event.input !== 'dtmf' && event.endpointMs;
      if (!this.measured && typeof engineMs === 'number')
        super.stage({ stage: 'stt.endpoint', durationMs: engineMs, outcome: 'succeeded' });
      this.measured = false;
    }
    super.engine(event);
  }

  override stage(sample: TurnStageSample): void {
    if (sample.stage === 'stt.endpoint') this.measured = true;
    super.stage(sample);
  }
}
