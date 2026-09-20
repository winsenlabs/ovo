import type { Inference } from '@winsendotai/ovo-contracts';
import {
  type StreamingStt,
  type StreamingSttSession,
  type StreamingTts,
} from '@winsendotai/ovo-plugin-voice';
import type { Context, PluginDefinition } from '@winsendotai/ovo-runtime';

type StageOutcome = 'succeeded' | 'failed' | 'timeout' | 'unknown';

export interface StageTelemetry {
  startStage(input: {
    stage: string;
    provider?: string;
    model?: string;
  }): (outcome?: StageOutcome) => boolean;
}

export interface StageIdentity {
  provider?: string;
  model?: string;
}

export function instrumentInferencePlugin(
  definition: PluginDefinition,
  telemetry: StageTelemetry,
  identity: StageIdentity,
): PluginDefinition {
  return instrumentPlugin(definition, 'ovo.inference', (service) =>
    instrumentInference(service as Inference, telemetry, identity),
  );
}

export function instrumentSttPlugin(
  definition: PluginDefinition,
  telemetry: StageTelemetry,
  identity: StageIdentity,
): PluginDefinition {
  return instrumentPlugin(definition, 'ovo.stt', (service) =>
    instrumentStreamingStt(service as StreamingStt, telemetry, identity),
  );
}

export function instrumentTtsPlugin(
  definition: PluginDefinition,
  telemetry: StageTelemetry,
  identity: StageIdentity,
): PluginDefinition {
  return instrumentPlugin(definition, 'ovo.tts-streaming', (service) =>
    instrumentStreamingTts(service as StreamingTts, telemetry, identity),
  );
}

export function instrumentInference(
  inference: Inference,
  telemetry: StageTelemetry,
  identity: StageIdentity,
): void {
  const generate = inference.generate.bind(inference);
  inference.generate = (request) =>
    timedPromise(() => generate(request), telemetry, { stage: 'inference', ...identity });
  if (!inference.stream) return;
  const stream = inference.stream.bind(inference);
  inference.stream = (request) =>
    timedIterable(() => stream(request), telemetry, { stage: 'inference', ...identity });
}

export function instrumentStreamingTts(
  tts: StreamingTts,
  telemetry: StageTelemetry,
  identity: StageIdentity,
): void {
  const synthesize = tts.synthesize.bind(tts);
  tts.synthesize = (input) =>
    timedIterable(() => synthesize(input), telemetry, { stage: 'tts', ...identity });
}

export function instrumentStreamingStt(
  stt: StreamingStt,
  telemetry: StageTelemetry,
  identity: StageIdentity,
): void {
  const start = stt.start.bind(stt);
  stt.start = async (input) => {
    const finishReady = beginStage(telemetry, { stage: 'stt.ready', ...identity });
    let finishProcessing: ReturnType<typeof beginStage> | undefined;
    const settleProcessing = (outcome: StageOutcome) => {
      finishProcessing?.(outcome);
      finishProcessing = undefined;
    };
    try {
      const session = await start({
        ...input,
        onTranscript: (revision) => {
          if (!finishProcessing && (revision.speechStarted || Boolean(revision.text.trim())))
            finishProcessing = beginStage(telemetry, { stage: 'stt', ...identity });
          input.onTranscript(revision);
          if (revision.speechFinal) settleProcessing('succeeded');
        },
      });
      finishReady('succeeded');
      return instrumentSttSession(session, settleProcessing);
    } catch (error) {
      finishReady(stageOutcome(error));
      settleProcessing(stageOutcome(error));
      throw error;
    }
  };
}

function instrumentSttSession(
  session: StreamingSttSession,
  settleProcessing: (outcome: StageOutcome) => void,
): StreamingSttSession {
  return {
    write: async (audio, signal) => {
      try {
        await session.write(audio, signal);
      } catch (error) {
        settleProcessing(stageOutcome(error));
        throw error;
      }
    },
    finish: async (signal) => {
      try {
        await session.finish(signal);
        settleProcessing('unknown');
      } catch (error) {
        settleProcessing(stageOutcome(error));
        throw error;
      }
    },
    close: async (reason) => {
      try {
        await session.close(reason);
      } finally {
        settleProcessing('unknown');
      }
    },
  };
}

function instrumentPlugin(
  definition: PluginDefinition,
  serviceKey: string,
  instrument: (service: unknown) => void,
): PluginDefinition {
  return {
    manifest: definition.manifest,
    apply: async (ctx: Context, config) => {
      await definition.apply(ctx, config);
      instrument(ctx.get(serviceKey));
    },
  };
}

async function timedPromise<T>(
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

async function* timedIterable<T>(
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

function beginStage(
  telemetry: StageTelemetry,
  input: { stage: string } & StageIdentity,
): (outcome: StageOutcome) => boolean {
  try {
    const finish = telemetry.startStage(input);
    return (outcome) => {
      try {
        return finish(outcome);
      } catch {
        return false;
      }
    };
  } catch {
    return () => false;
  }
}

function stageOutcome(error: unknown): StageOutcome {
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'timeout';
  if (error instanceof DOMException && error.name === 'AbortError') return 'unknown';
  return 'failed';
}
