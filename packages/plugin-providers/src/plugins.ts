import type { SecretResolver } from '@winsendotai/ovo-contracts';
import { AiSdkInference } from '@winsendotai/ovo-plugin-inference';
import {
  createStreamingMediaSpeechOutputPlugin,
  type StreamingStt,
  type TranscriptRevision,
} from '@winsendotai/ovo-plugin-voice';
import { definePlugin, type Context, type PluginDefinition } from '@winsendotai/ovo-runtime';
import { DeepgramStreamingStt } from './deepgram.ts';
import { OpenAiModelFactory } from './openai-model.ts';
import { OpenAiBatchTranscriber } from './openai-transcription.ts';
import { OpenAiCachedTtsBridge, OpenAiStreamingTts } from './openai-tts.ts';
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

const EMPTY_CONFIG_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false });

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
}

export interface DeepgramPluginOptions extends ProviderPluginOptions {
  transcript?: (revision: Readonly<TranscriptRevision>) => void | Promise<void>;
}

export function createDeepgramSttPlugin(
  binding: DeepgramBinding,
  options: DeepgramPluginOptions = {},
): PluginDefinition {
  const snapshot = immutableBinding(binding);
  return definePlugin(
    manifest(
      PROVIDER_PLUGIN_IDS.deepgramStt,
      [PROVIDER_SERVICE_KEYS.secretResolver],
      [PROVIDER_SERVICE_KEYS.streamingStt],
    ),
    async (ctx) => {
      const secrets = secretResolver(ctx);
      const streaming = await DeepgramStreamingStt.create(snapshot, {
        secrets,
        usage: options.usage,
      });
      ctx.provide(
        PROVIDER_SERVICE_KEYS.streamingStt,
        options.transcript ? observeStreamingTranscripts(streaming, options.transcript) : streaming,
      );
    },
  );
}

export function observeStreamingTranscripts(
  streaming: StreamingStt,
  observer: NonNullable<DeepgramPluginOptions['transcript']>,
): StreamingStt {
  return {
    start: (input) =>
      streaming.start({
        ...input,
        onTranscript: (revision) => {
          try {
            void Promise.resolve(observer(Object.freeze(structuredClone(revision)))).catch(
              () => undefined,
            );
          } catch {
            // Audit/telemetry observation cannot interrupt the live STT consumer.
          }
          input.onTranscript(revision);
        },
      }),
  };
}

export function createOpenAiTtsPlugin(
  binding: OpenAiTtsBinding,
  options: ProviderPluginOptions = {},
): PluginDefinition {
  const snapshot = immutableBinding(binding);
  return definePlugin(
    manifest(
      PROVIDER_PLUGIN_IDS.openAiTts,
      [PROVIDER_SERVICE_KEYS.secretResolver],
      [PROVIDER_SERVICE_KEYS.streamingTts, PROVIDER_SERVICE_KEYS.cachedTts],
    ),
    async (ctx) => {
      const streaming = await OpenAiStreamingTts.create(snapshot, {
        secrets: secretResolver(ctx),
        usage: options.usage,
      });
      ctx.provide(PROVIDER_SERVICE_KEYS.streamingTts, streaming);
      ctx.provide(PROVIDER_SERVICE_KEYS.cachedTts, new OpenAiCachedTtsBridge(streaming));
    },
  );
}

/** Alternate batch-only STT. It intentionally does not provide ovo.stt. */
export function createOpenAiBatchSttPlugin(
  binding: OpenAiBatchSttBinding,
  options: ProviderPluginOptions = {},
): PluginDefinition {
  const snapshot = immutableBinding(binding);
  return definePlugin(
    manifest(
      PROVIDER_PLUGIN_IDS.openAiBatchStt,
      [PROVIDER_SERVICE_KEYS.secretResolver],
      [PROVIDER_SERVICE_KEYS.batchStt],
    ),
    async (ctx) => {
      ctx.provide(
        PROVIDER_SERVICE_KEYS.batchStt,
        await OpenAiBatchTranscriber.create(snapshot, {
          secrets: secretResolver(ctx),
          usage: options.usage,
        }),
      );
    },
  );
}

export function createOpenAiInferenceProviderPlugin(
  binding: OpenAiInferenceBinding,
  options: {
    onInferenceUsage?: import('@winsendotai/ovo-plugin-inference').AiSdkInferenceOptions['onUsage'];
  } = {},
): PluginDefinition {
  const snapshot = immutableBinding(binding);
  return definePlugin(
    {
      ...manifest(
        PROVIDER_PLUGIN_IDS.openAiInference,
        [PROVIDER_SERVICE_KEYS.secretResolver],
        [PROVIDER_SERVICE_KEYS.inference],
      ),
      configSchema: OPENAI_INFERENCE_PLUGIN_CONFIG_SCHEMA,
    },
    async (ctx, rawConfig) => {
      const config = parseInferenceConfig(rawConfig);
      const factory = await OpenAiModelFactory.create(snapshot, secretResolver(ctx));
      ctx.provide(
        PROVIDER_SERVICE_KEYS.inference,
        new AiSdkInference({
          model: factory.model(),
          instructions: config.instructions,
          maxOutputTokens: config.maxOutputTokens,
          onUsage: options.onInferenceUsage,
        }),
      );
    },
  );
}

export function createStreamingSpeechOutputPlugin(): PluginDefinition {
  return createStreamingMediaSpeechOutputPlugin();
}

function manifest(id: string, requires: string[], provides: string[]) {
  return {
    id,
    version: '0.1.0',
    contractVersion: 1 as const,
    scope: 'session' as const,
    requires,
    provides,
    configSchema: EMPTY_CONFIG_SCHEMA,
    secretFields: [],
  };
}

function secretResolver(ctx: Context): SecretResolver {
  return ctx.get(PROVIDER_SERVICE_KEYS.secretResolver) as SecretResolver;
}

function parseInferenceConfig(config: Record<string, unknown>): {
  instructions?: string;
  maxOutputTokens?: number;
} {
  const unknown = Object.keys(config).filter(
    (key) => !['instructions', 'maxOutputTokens'].includes(key),
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
