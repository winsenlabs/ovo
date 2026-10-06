import type { Context, PluginDefinition } from '@winsendotai/ovo-runtime';

/** How a provider stage ended. Stages observe provider calls and never change them. */
export type StageOutcome = 'succeeded' | 'failed' | 'timeout' | 'unknown';

export type FinishStage = (outcome: StageOutcome, payload?: Record<string, unknown>) => boolean;

export interface StageTelemetry {
  startStage(input: {
    stage: string;
    provider?: string;
    model?: string;
  }): (outcome?: StageOutcome, payload?: Record<string, unknown>) => boolean;
  /** A duration measured elsewhere, such as endpointing reconstructed from word timings. */
  recordStage?(input: {
    stage: string;
    durationMs: number;
    provider?: string;
    model?: string;
    payload?: Record<string, unknown>;
  }): boolean;
}

export interface StageIdentity {
  provider?: string;
  model?: string;
}

export function instrumentPlugin(
  definition: PluginDefinition,
  serviceKey: string,
  instrument: (service: unknown) => void,
): PluginDefinition {
  return {
    manifest: definition.manifest,
    apply: async (ctx: Context, config) => {
      await definition.apply(ctx, config);
      instrument(ctx.reflect.get(serviceKey, false));
    },
  };
}

export async function timedPromise<T>(
  operation: () => Promise<T>,
  telemetry: StageTelemetry,
  input: { stage: string } & StageIdentity,
): Promise<T> {
  const finish = beginStage(telemetry, input);
  try {
    const value = await operation();
    finish('succeeded');
    return value;
  } catch (error) {
    finish(stageOutcome(error));
    throw error;
  }
}

export async function* timedIterable<T>(
  operation: () => AsyncIterable<T>,
  telemetry: StageTelemetry,
  input: { stage: string } & StageIdentity,
): AsyncIterable<T> {
  const finish = beginStage(telemetry, input);
  try {
    yield* operation();
    finish('succeeded');
  } catch (error) {
    finish(stageOutcome(error));
    throw error;
  }
}

export function beginStage(
  telemetry: StageTelemetry,
  input: { stage: string } & StageIdentity,
): FinishStage {
  try {
    const finish = telemetry.startStage(input);
    return (outcome, payload) => {
      try {
        return finish(outcome, payload);
      } catch {
        return false;
      }
    };
  } catch {
    return () => false;
  }
}

export function recordStage(
  telemetry: StageTelemetry,
  input: Parameters<NonNullable<StageTelemetry['recordStage']>>[0],
): void {
  try {
    telemetry.recordStage?.(input);
  } catch {
    // Telemetry never interrupts speech recognition.
  }
}

export function stageOutcome(error: unknown): StageOutcome {
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'timeout';
  if (error instanceof DOMException && error.name === 'AbortError') return 'unknown';
  return 'failed';
}
