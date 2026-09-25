import { Cap } from '@winsendotai/ovo-contracts';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { openAiInference, type OpenAiInferenceConfig } from './inference.ts';
import { fixtures, fixtureTemplates } from './testing.ts';

export { openAiInference, type OpenAiInferenceConfig } from './inference.ts';
export { fixtures, fixtureTemplates };

export const openAiInferencePlugin = definePlugin(
  {
    id: '@winsendotai/ovo-provider-openai-inference',
    version: '0.1.0', contractVersion: 2, scope: 'session', kind: 'llm', provider: 'openai',
    provides: [Cap.inference], requires: [], optional: [Cap.usage],
    configSchema: {
      type: 'object',
      properties: { binding: { type: 'object' }, credentialRef: { type: 'object' } },
      additionalProperties: false,
    },
    bindingSchema: {
      type: 'object', required: ['model'],
      properties: {
        model: { type: 'string', minLength: 1 },
        temperature: { type: 'number', minimum: 0, maximum: 2 },
        maxOutputTokens: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
    secretFields: ['/credentialRef'],
    capabilities: { tools: true, streaming: true },
    meters: [
      { key: 'openai.inference.input_tokens', unit: 'input_tokens', label: 'OpenAI inference input tokens', role: 'llm' },
      { key: 'openai.inference.uncached_input_tokens', unit: 'uncached_input_tokens', label: 'OpenAI inference uncached input tokens', role: 'llm' },
      { key: 'openai.inference.cache_read_input_tokens', unit: 'cache_read_input_tokens', label: 'OpenAI inference cached input tokens', role: 'llm' },
      { key: 'openai.inference.cache_write_input_tokens', unit: 'cache_write_input_tokens', label: 'OpenAI inference cache write input tokens', role: 'llm' },
      { key: 'openai.inference.output_tokens', unit: 'output_tokens', label: 'OpenAI inference output tokens', role: 'llm' },
    ],
    runtime: { egressHosts: ['api.openai.com'], modelLicences: [] },
    conformance: ['llm@1'],
    ui: { label: 'OpenAI Inference', vendor: 'OpenAI', slot: 'llm' },
  },
  async (ctx, row) => {
    const binding = (row.binding ?? {}) as OpenAiInferenceConfig;
    const apiKey = await ctx.secret('/credentialRef');
    ctx.provide(Cap.inference, openAiInference(ctx.net, apiKey, binding, ctx.maybe(Cap.usage)));
  },
);
export const plugins = [openAiInferencePlugin];
