import {
  Cap,
  type MediaDuplex,
  type TextToSpeech,
  type UsageSink,
} from '@winsendotai/ovo-contracts';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { STREAMING_VOICE_PLUGIN_IDS } from '../production-plugins.ts';
import { NativeStreamingSpeechOutput } from './media-output-v2.ts';

export function createNativeStreamingMediaOutputPlugin() {
  return definePlugin(
    {
      id: STREAMING_VOICE_PLUGIN_IDS.mediaOutput,
      version: '0.1.0',
      contractVersion: 2,
      scope: 'session',
      kind: 'infra',
      requires: [Cap.tts, Cap.media],
      optional: [Cap.usage],
      provides: [Cap.output],
      configSchema: {
        type: 'object',
        properties: {
          voice: { type: 'string', minLength: 1, maxLength: 120 },
          markTimeoutMs: { type: 'integer', minimum: 1, maximum: 120_000 },
          maxPrefetchBytes: { type: 'integer', minimum: 1, maximum: 8_388_608 },
          allowWeakEvidence: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      secretFields: [],
    },
    (ctx, config) => {
      const output = new NativeStreamingSpeechOutput(
        ctx.get(Cap.tts) as TextToSpeech,
        ctx.get(Cap.media) as MediaDuplex,
        undefined,
        (ctx.maybe(Cap.usage) as UsageSink | undefined) ?? (() => undefined),
        config as { voice?: string; markTimeoutMs?: number; maxPrefetchBytes?: number },
      );
      ctx.provide(Cap.output, output);
      ctx.effect(() => () => output.dispose());
    },
  );
}
