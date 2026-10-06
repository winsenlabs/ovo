import { performance } from 'node:perf_hooks';
import type {
  TelemetryOutcome,
  TurnTelemetryCollector,
  WorkerTelemetryAdapter,
} from '@winsendotai/ovo-plugin-observability';

export type StageInput = {
  stage: string;
  stageId?: string;
  provider?: string;
  model?: string;
  turnId?: string;
  responseEpoch?: number;
};
export type StageFinish = (
  outcome?: Exclude<TelemetryOutcome, 'running'>,
  payload?: Record<string, unknown>,
) => boolean;
export type SettledStage = StageInput & {
  durationMs: number;
  outcome: Exclude<TelemetryOutcome, 'running'>;
  payload?: Record<string, unknown>;
};

const REPLY_STAGES = new Set(['grounding', 'decision', 'inference', 'llm_first_token', 'tts']);

/**
 * Reply stages carry no turn; they are stamped with the turn the engine is running. Recognition
 * stages are left unstamped: they measure the caller's next turn, not the running one.
 */
export function startTurnStage(
  adapter: WorkerTelemetryAdapter,
  turns: TurnTelemetryCollector,
  input: StageInput,
  onSettled: (stage: SettledStage) => void,
): StageFinish {
  const running = REPLY_STAGES.has(input.stage) ? turns.activeTurnId : undefined;
  const stage = { ...input, turnId: input.turnId ?? running };
  const started = performance.now();
  const finish = adapter.startStage(stage);
  let settled = false;
  return (outcome = 'succeeded', payload) => {
    if (settled) return false;
    settled = true;
    const accepted = finish(outcome, payload);
    const done = {
      ...stage,
      durationMs: Math.max(0, performance.now() - started),
      outcome,
      payload,
    };
    turns.stage(done);
    onSettled(done);
    return accepted;
  };
}
