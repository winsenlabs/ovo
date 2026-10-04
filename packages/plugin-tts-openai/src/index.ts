import { Cap } from '@winsendotai/ovo-contracts';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { OPENAI_TTS_CAPABILITIES, OpenAiTts, type OpenAiTtsConfig } from './tts.ts';
import { fixtures, fixtureTemplates } from './testing.ts';

export { OPENAI_TTS_CAPABILITIES, OpenAiTts, type OpenAiTtsConfig } from './tts.ts';
export { OpenAiBatchTranscriber, type OpenAiBatchSttBinding } from './batch.ts';
export { createMonoWav } from './batch-wav.ts';
export { fixtures, fixtureTemplates };

export const openAiTtsPlugin = definePlugin(
  {
    id: '@winsendotai/ovo-provider-openai-tts',
    version: '0.1.0',
    contractVersion: 2,
    scope: 'session',
    kind: 'tts',
    provider: 'openai',
    provides: [`${Cap.tts}@2`],
    requires: [],
    configSchema: {
      type: 'object',
      properties: {
        binding: { type: 'object' },
        credentialRef: { type: 'object' },
        workspaceId: { type: 'string' },
        bindingId: { type: 'string' },
        updatedAt: { type: 'string' },
      },
      additionalProperties: false,
    },
    bindingSchema: {
      type: 'object',
      required: ['model', 'voice'],
      properties: {
        model: {
          type: 'string',
          enum: ['gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-12-15', 'tts-1', 'tts-1-hd'],
        },
        voice: { type: 'string', minLength: 1 },
        instructions: { type: 'string' },
        speed: { type: 'number', minimum: 0.25, maximum: 4 },
      },
      additionalProperties: false,
    },
    secretFields: [''],
    capabilities: OPENAI_TTS_CAPABILITIES,
    meters: [
      {
        key: 'openai.streaming-tts.characters',
        unit: 'characters',
        label: 'OpenAI TTS characters',
        role: 'tts',
        when: { field: 'model', in: ['tts-1', 'tts-1-hd'] },
      },
      {
        key: 'openai.streaming-tts.input_tokens',
        unit: 'input_tokens',
        label: 'OpenAI TTS input tokens',
        role: 'tts',
        when: { field: 'model', in: ['gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-12-15'] },
      },
      {
        key: 'openai.streaming-tts.audio_output_tokens',
        unit: 'audio_output_tokens',
        label: 'OpenAI TTS audio output tokens',
        role: 'tts',
        when: { field: 'model', in: ['gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-12-15'] },
      },
    ],
    runtime: { egressHosts: ['api.openai.com'], modelLicences: [] },
    conformance: ['tts@1'],
    ui: { label: 'OpenAI Text to Speech', vendor: 'OpenAI', slot: 'tts' },
  },
  async (ctx, row) => {
    const binding = (row.binding ?? {}) as OpenAiTtsConfig;
    const ref = row.credentialRef;
    const apiKey = await ctx.secret(
      ref && typeof ref === 'object' && 'credentialRef' in ref ? '/credentialRef' : '',
    );
    ctx.provide(Cap.tts, new OpenAiTts(ctx.net, apiKey, binding));
  },
);
export const plugins = [openAiTtsPlugin];
