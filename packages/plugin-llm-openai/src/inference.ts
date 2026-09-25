import { createOpenAI } from '@ai-sdk/openai';
import { defaultSettingsMiddleware, wrapLanguageModel } from 'ai';
import type { NetPort, UsageSink } from '@winsendotai/ovo-contracts';
import { AiSdkInference } from '@winsendotai/ovo-plugin-kit';

export interface OpenAiInferenceConfig {
  model: string;
  temperature?: number;
  maxOutputTokens?: number;
}

export function openAiInference(
  net: NetPort,
  apiKey: string,
  binding: OpenAiInferenceConfig,
  usage?: UsageSink,
): AiSdkInference {
  const provider = createOpenAI({
    apiKey,
    fetch: (url, init) => net.fetch(String(url), init ? { ...init, signal: init.signal ?? undefined } : undefined),
  });
  if (binding.temperature !== undefined &&
    (!Number.isFinite(binding.temperature) || binding.temperature < 0 || binding.temperature > 2))
    throw new TypeError('OpenAI temperature must be between 0 and 2');
  const model = provider.responses(binding.model);
  return new AiSdkInference({
    model: binding.temperature === undefined ? model : wrapLanguageModel({
      model,
      middleware: defaultSettingsMiddleware({ settings: { temperature: binding.temperature } }),
    }),
    provider: 'openai',
    maxOutputTokens: binding.maxOutputTokens,
    usage,
  });
}
