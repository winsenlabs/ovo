import { Cap, type Inference, type UsageSink } from '@winsendotai/ovo-contracts';
import {
  createOpenAiInferenceProviderPlugin,
  openAiInferenceBindingFromRecord,
} from '@winsendotai/ovo-plugin-providers';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { factoryContext, PROVIDER_MANIFEST_COMMON, storedBinding } from './support.ts';

export const openAiLlmBridge = definePlugin(
  {
    id: '@winsendotai/ovo-provider-openai-inference',
    ...PROVIDER_MANIFEST_COMMON,
    kind: 'llm',
    provider: 'openai',
    provides: [Cap.inference],
    bindingSchema: {
      type: 'object',
      required: ['model'],
      properties: {
        model: { type: 'string', minLength: 1 },
        api: { enum: ['responses', 'chat'] },
      },
      additionalProperties: false,
    },
    capabilities: { tools: true, streaming: true },
    meters: [
      {
        key: 'openai.inference.input_tokens',
        unit: 'input_tokens',
        label: 'OpenAI input tokens',
        role: 'llm',
      },
      {
        key: 'openai.inference.output_tokens',
        unit: 'output_tokens',
        label: 'OpenAI output tokens',
        role: 'llm',
      },
    ],
    runtime: { egressHosts: ['api.openai.com'], modelLicences: [] },
    conformance: ['llm@1'],
  },
  async (ctx, config) => {
    const binding = openAiInferenceBindingFromRecord(storedBinding(config, 'openai'));
    const sink = ctx.get(Cap.usage) as UsageSink;
    let next = 0;
    const old = createOpenAiInferenceProviderPlugin(binding, {
      onInferenceUsage: ({ requestId, usage }) => {
        const id = requestId ?? `openai:legacy:${++next}`;
        for (const [field, unit] of [
          ['inputTokens', 'input_tokens'],
          ['outputTokens', 'output_tokens'],
        ] as const) {
          if (typeof usage[field] === 'number')
            sink({
              provider: 'openai',
              operation: 'inference',
              unit,
              quantity: String(Math.trunc(usage[field])),
              state: 'reconciled',
              requestId: id,
              elapsedMs: 0,
            });
        }
      },
    });
    await old.apply(
      factoryContext(ctx, (key, value) => {
        if (key !== Cap.inference) throw new Error(`Unexpected OpenAI service ${key}`);
        ctx.provide(Cap.inference, value as Inference);
      }),
      {
        ...(config.instructions === undefined ? {} : { instructions: config.instructions }),
        ...(config.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: config.maxOutputTokens }),
      },
    );
  },
);
