import { createOpenAI } from '@ai-sdk/openai';
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
  return new AiSdkInference({
    model: provider.responses(binding.model),
    provider: 'openai',
    maxOutputTokens: binding.maxOutputTokens,
    usage,
  });
}
