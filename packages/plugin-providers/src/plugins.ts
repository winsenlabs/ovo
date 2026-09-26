import {
  MULAW_8K,
  type NetPort,
  type SecretResolver,
  type TranscriptRevision,
  type UsageMeter,
} from '@winsendotai/ovo-contracts';
import { createStreamingMediaSpeechOutputPlugin } from '@winsendotai/ovo-plugin-voice';
import { definePlugin, type Context, type PluginDefinition } from '@winsendotai/ovo-runtime';
import type { AiSdkInferenceOptions } from '@winsendotai/ovo-plugin-inference';
import { sttAsLegacy } from '../../plugin-kit/src/speech-shims.ts';
import { DeepgramStt } from '../../plugin-stt-deepgram/src/index.ts';
import { observeStreamingTranscripts } from '../../plugin-stt-deepgram/src/legacy-observer.ts';
import { OpenAiTts, type OpenAiTtsModel } from '../../plugin-tts-openai/src/tts.ts';
import { OpenAiBatchTranscriber } from '../../plugin-tts-openai/src/batch.ts';
import { openAiInference } from '../../plugin-llm-openai/src/inference.ts';
import { legacyTtsPorts } from './legacy-tts.ts';
import {
  PROVIDER_PLUGIN_IDS,
  PROVIDER_SERVICE_KEYS,
  immutableBinding,
  type DeepgramBinding,
  type OpenAiBatchSttBinding,
  type OpenAiInferenceBinding,
  type OpenAiTtsBinding,
  type ProviderUsageSink,
} from './types.ts';

export const OPENAI_INFERENCE_PLUGIN_CONFIG_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    instructions: { type: 'string', maxLength: 20_000 },
    maxOutputTokens: { type: 'integer', minimum: 1, maximum: 32_000 },
  },
  additionalProperties: false,
});

export interface ProviderPluginOptions {
  usage?: ProviderUsageSink;
  /** The old bridge has no network port. Direct legacy callers must pass the host port. */
  net?: NetPort;
}

export interface DeepgramPluginOptions extends ProviderPluginOptions {
  transcript?: (revision: Readonly<TranscriptRevision>) => void | Promise<void>;
}

/** Legacy factory name. The distribution's same-id rule selects the native v2 definition. */
export function createDeepgramSttPlugin(
  binding: DeepgramBinding,
  options: DeepgramPluginOptions = {},
): PluginDefinition {
  const snapshot = immutableBinding(binding);
  return definePlugin(
    manifest(PROVIDER_PLUGIN_IDS.deepgramStt, [PROVIDER_SERVICE_KEYS.streamingStt]),
    async (ctx) => {
      const key = await secrets(ctx).resolve(snapshot.workspaceId, snapshot.credentialId);
      const provider = new DeepgramStt(network(options), key, {
        model: snapshot.model,
        language: snapshot.language,
        endpointingMs: snapshot.endpointingMs,
        utteranceEndMs: snapshot.utteranceEndMs,
      });
      const legacy = sttAsLegacy(provider, MULAW_8K, {
        onUsage: (meter) => options.usage?.(legacyUsage(meter, 'streaming-stt')),
      });
      ctx.provide(
        PROVIDER_SERVICE_KEYS.streamingStt,
        options.transcript ? observeStreamingTranscripts(legacy, options.transcript) : legacy,
      );
    },
  );
}

/** Legacy factory name. Audio format adaptation now belongs to the session host. */
export function createOpenAiTtsPlugin(
  binding: OpenAiTtsBinding,
  options: ProviderPluginOptions = {},
): PluginDefinition {
  const snapshot = immutableBinding(binding);
  return definePlugin(
    manifest(PROVIDER_PLUGIN_IDS.openAiTts, [
      PROVIDER_SERVICE_KEYS.streamingTts,
      PROVIDER_SERVICE_KEYS.cachedTts,
    ]),
    async (ctx) => {
      const key = await secrets(ctx).resolve(snapshot.workspaceId, snapshot.credentialId);
      const provider = new OpenAiTts(network(options), key, {
        model: snapshot.model as OpenAiTtsModel,
        voice: snapshot.voice,
        instructions: snapshot.instructions,
        speed: snapshot.speed,
      });
      const ports = legacyTtsPorts(provider, snapshot, (meter) =>
        options.usage?.(legacyUsage(meter, 'streaming-tts')),
      );
      ctx.provide(PROVIDER_SERVICE_KEYS.streamingTts, ports.streaming);
      ctx.provide(PROVIDER_SERVICE_KEYS.cachedTts, ports.cached);
    },
  );
}

/** Legacy factory name. Model creation and usage metering live in the v2 package. */
export function createOpenAiInferenceProviderPlugin(
  binding: OpenAiInferenceBinding,
  options: { onInferenceUsage?: AiSdkInferenceOptions['onUsage']; net?: NetPort } = {},
): PluginDefinition {
  const snapshot = immutableBinding(binding);
  return definePlugin(
    {
      ...manifest(PROVIDER_PLUGIN_IDS.openAiInference, [PROVIDER_SERVICE_KEYS.inference]),
      configSchema: OPENAI_INFERENCE_PLUGIN_CONFIG_SCHEMA,
    },
    async (ctx, config) => {
      if (snapshot.api !== 'responses')
        throw new TypeError('Legacy OpenAI chat bindings cannot use the Responses API');
      const parsed = parseInferenceConfig(config);
      const key = await secrets(ctx).resolve(snapshot.workspaceId, snapshot.credentialId);
      ctx.provide(
        PROVIDER_SERVICE_KEYS.inference,
        openAiInference(
          network(options),
          key,
          {
            model: snapshot.model,
            maxOutputTokens: parsed.maxOutputTokens,
            instructions: parsed.instructions,
          },
          undefined,
          options.onInferenceUsage,
        ),
      );
    },
  );
}

function parseInferenceConfig(config: Record<string, unknown>): {
  instructions?: string;
  maxOutputTokens?: number;
} {
  const unknown = Object.keys(config).filter(
    (key) => key !== 'instructions' && key !== 'maxOutputTokens',
  );
  if (unknown.length) throw new TypeError(`Unknown OpenAI inference config: ${unknown.join(', ')}`);
  if (config.instructions !== undefined && typeof config.instructions !== 'string')
    throw new TypeError('instructions must be a string');
  if (
    config.maxOutputTokens !== undefined &&
    (!Number.isSafeInteger(config.maxOutputTokens) ||
      Number(config.maxOutputTokens) < 1 ||
      Number(config.maxOutputTokens) > 32_000)
  )
    throw new TypeError('maxOutputTokens must be an integer between 1 and 32000');
  return {
    instructions: config.instructions as string | undefined,
    maxOutputTokens: config.maxOutputTokens as number | undefined,
  };
}

function manifest(id: string, provides: string[]) {
  return {
    id,
    version: '0.1.0',
    contractVersion: 1 as const,
    scope: 'session' as const,
    requires: [PROVIDER_SERVICE_KEYS.secretResolver],
    provides,
    configSchema: { type: 'object', additionalProperties: false },
    secretFields: [],
  };
}

function secrets(ctx: Context): SecretResolver {
  return ctx.get(PROVIDER_SERVICE_KEYS.secretResolver) as SecretResolver;
}

/** A bypassed frozen bridge fails loudly on egress; distribution loads the v2 package instead. */
function network(options: { net?: NetPort }): NetPort {
  if (options.net) return options.net;
  const unavailable = () => {
    throw new Error('Legacy provider bridge has no host NetPort; select the v2 package');
  };
  return { fetch: unavailable, websocket: unavailable };
}

function legacyUsage(meter: UsageMeter, operation: 'streaming-stt' | 'streaming-tts') {
  const base = {
    requestId: meter.requestId,
    elapsedMs: meter.elapsedMs,
    quantity: meter.quantity,
    state: meter.state,
  };
  if (operation === 'streaming-stt') {
    if (meter.provider !== 'deepgram' || meter.unit !== 'audio_seconds')
      throw new TypeError('Unexpected legacy STT meter');
    return { ...base, provider: 'deepgram' as const, operation, unit: 'audio_seconds' as const };
  }
  if (
    meter.provider !== 'openai' ||
    (meter.unit !== 'characters' &&
      meter.unit !== 'input_tokens' &&
      meter.unit !== 'audio_output_tokens')
  )
    throw new TypeError('Unexpected legacy TTS meter');
  return { ...base, provider: 'openai' as const, operation, unit: meter.unit };
}

/** Batch transcription has no v2 contract yet, so this separate v1 capability stays unregistered. */
export function createOpenAiBatchSttPlugin(
  binding: OpenAiBatchSttBinding,
  options: ProviderPluginOptions = {},
): PluginDefinition {
  const snapshot = immutableBinding(binding);
  return definePlugin(
    {
      id: PROVIDER_PLUGIN_IDS.openAiBatchStt,
      version: '0.1.0',
      contractVersion: 1,
      scope: 'session',
      requires: [PROVIDER_SERVICE_KEYS.secretResolver],
      provides: [PROVIDER_SERVICE_KEYS.batchStt],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
    },
    async (ctx) => {
      const secrets = ctx.get(PROVIDER_SERVICE_KEYS.secretResolver) as SecretResolver;
      if (!options.net) throw new Error('Batch STT requires a host NetPort');
      ctx.provide(
        PROVIDER_SERVICE_KEYS.batchStt,
        await OpenAiBatchTranscriber.create(snapshot, {
          secrets,
          net: options.net,
          usage: options.usage,
        }),
      );
    },
  );
}

export { observeStreamingTranscripts };

export function createStreamingSpeechOutputPlugin(): PluginDefinition {
  return createStreamingMediaSpeechOutputPlugin();
}
