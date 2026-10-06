import { Cap } from '@winsendotai/ovo-contracts';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { openAiInference, type OpenAiInferenceConfig } from './inference.ts';
import { fixtures, fixtureTemplates } from './testing.ts';
import { REASONING_EFFORTS, SERVICE_TIERS, TEXT_VERBOSITIES } from './voice-tuning.ts';

export { openAiInference, type OpenAiInferenceConfig } from './inference.ts';
export {
  defaultTextVerbosity,
  lowestReasoningEffort,
  resolveVoiceTuning,
  type VoiceTuning,
} from './voice-tuning.ts';
export { fixtures, fixtureTemplates };

const INFERENCE_METER_LABELS = {
  input_tokens: 'OpenAI inference input tokens',
  uncached_input_tokens: 'OpenAI inference uncached input tokens',
  cache_read_input_tokens: 'OpenAI inference cached input tokens',
  cache_write_input_tokens: 'OpenAI inference cache write input tokens',
  output_tokens: 'OpenAI inference output tokens',
} as const;
const INFERENCE_METERS = (
  Object.keys(INFERENCE_METER_LABELS) as Array<keyof typeof INFERENCE_METER_LABELS>
).map((unit) => ({
  key: `openai.inference.${unit}`,
  unit,
  label: INFERENCE_METER_LABELS[unit],
  role: 'llm' as const,
}));

export const openAiInferencePlugin = definePlugin(
  {
    id: '@winsendotai/ovo-provider-openai-inference',
    version: '0.1.0',
    contractVersion: 2,
    scope: 'session',
    kind: 'llm',
    provider: 'openai',
    provides: [Cap.inference],
    requires: [],
    optional: [Cap.usage],
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
      required: ['model'],
      properties: {
        model: { type: 'string', minLength: 1 },
        api: { enum: ['responses'] },
        temperature: { type: 'number', minimum: 0, maximum: 2 },
        maxOutputTokens: { type: 'integer', minimum: 1 },
        reasoningEffort: { enum: [...REASONING_EFFORTS] },
        textVerbosity: { enum: [...TEXT_VERBOSITIES] },
        serviceTier: { enum: [...SERVICE_TIERS] },
        promptCacheKey: { type: 'string', minLength: 1, maxLength: 64 },
        store: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    secretFields: [''],
    capabilities: { tools: true, streaming: true },
    meters: INFERENCE_METERS,
    runtime: { egressHosts: ['api.openai.com'], modelLicences: [] },
    conformance: ['llm@1'],
    ui: { label: 'OpenAI Inference', vendor: 'OpenAI', slot: 'llm' },
  },
  async (ctx, row) => {
    const binding = (row.binding ?? {}) as OpenAiInferenceConfig;
    if ('api' in binding && binding.api !== 'responses')
      throw new TypeError('OpenAI v2 inference supports only the Responses API');
    const ref = row.credentialRef;
    const apiKey = await ctx.secret(
      ref && typeof ref === 'object' && 'credentialRef' in ref ? '/credentialRef' : '',
    );
    ctx.provide(
      Cap.inference,
      openAiInference(ctx.net, apiKey, binding, ctx.maybe(Cap.usage), undefined, {
        env: process.env,
        bindingId: typeof row.bindingId === 'string' ? row.bindingId : undefined,
      }),
    );
  },
);
export const plugins = [openAiInferencePlugin];
