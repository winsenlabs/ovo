import type {
  Inference,
  SpeechToText,
  SttSession,
  StreamingStt,
  StreamingSttSession,
  StreamingTts,
} from '@winsendotai/ovo-contracts';
import { inferenceActivity } from '@winsendotai/ovo-plugin-kit';
import type { PluginDefinition } from '@winsendotai/ovo-runtime';
import { EndpointClock, timeFirstToken, timeWebSearches } from './telemetry-stage-clocks.ts';
import {
  beginStage,
  instrumentPlugin,
  recordStage,
  stageOutcome,
  timedIterable,
  timedPromise,
  type StageIdentity,
  type StageOutcome,
  type StageTelemetry,
} from './telemetry-stage-core.ts';

export type { StageIdentity, StageTelemetry } from './telemetry-stage-core.ts';

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
    instrumentSpeechToText(service as SpeechToText, telemetry, identity),
  );
}

/** Session-graph providers expose STT v2; preserve cancel and forceEndpoint. */
export function instrumentSpeechToText(
  stt: SpeechToText,
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
    const endpoint = new EndpointClock(input.format);
    try {
      const session = await start({
        ...input,
        onEvent: (event) => {
          if (
            !finishProcessing &&
            (event.type === 'speech-start' ||
              (event.type === 'transcript' && Boolean(event.segment.text.trim())))
          )
            finishProcessing = beginStage(telemetry, { stage: 'stt', ...identity });
          // Recorded before the engine sees end-of-turn, which may accept the turn synchronously.
          endpoint.observe(event, (durationMs, payload) =>
            recordStage(telemetry, { stage: 'stt.endpoint', durationMs, payload, ...identity }),
          );
          input.onEvent(event);
          if (event.type === 'end-of-turn' && !event.eager) settleProcessing('succeeded');
          if (event.type === 'utterance-end') settleProcessing('succeeded');
        },
      });
      finishReady('succeeded');
      return instrumentV2SttSession(session, settleProcessing, endpoint);
    } catch (error) {
      finishReady(stageOutcome(error));
      settleProcessing(stageOutcome(error));
      throw error;
    }
  };
}

function instrumentV2SttSession(
  session: SttSession,
  settleProcessing: (outcome: StageOutcome) => void,
  endpoint: EndpointClock,
): SttSession {
  return {
    write: async (frame, signal) => {
      endpoint.wrote(frame.byteLength);
      try {
        await session.write(frame, signal);
      } catch (error) {
        settleProcessing(stageOutcome(error));
        throw error;
      }
    },
    ...(session.forceEndpoint ? { forceEndpoint: () => session.forceEndpoint!() } : {}),
    ...(session.updateConfiguration
      ? { updateConfiguration: (update) => session.updateConfiguration!(update) }
      : {}),
    finish: async (signal) => {
      try {
        await session.finish(signal);
        settleProcessing('unknown');
      } catch (error) {
        settleProcessing(stageOutcome(error));
        throw error;
      }
    },
    cancel: async (reason) => {
      try {
        await session.cancel(reason);
      } finally {
        settleProcessing('unknown');
      }
    },
  };
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
  const activity = inferenceActivity(inference);
  if (activity)
    timeWebSearches(activity, () => beginStage(telemetry, { stage: 'web_search', ...identity }));
  const generate = inference.generate.bind(inference);
  inference.generate = (request) =>
    timedPromise(() => generate(request), telemetry, { stage: 'inference', ...identity });
  if (!inference.stream) return;
  const stream = inference.stream.bind(inference);
  inference.stream = (request) =>
    timedIterable(
      () =>
        timeFirstToken(stream(request), () =>
          beginStage(telemetry, { stage: 'llm_first_token', ...identity }),
        ),
      telemetry,
      { stage: 'inference', ...identity },
    );
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
