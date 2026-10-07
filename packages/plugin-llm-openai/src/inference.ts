import { createOpenAI } from '@ai-sdk/openai';
import { defaultSettingsMiddleware, wrapLanguageModel } from 'ai';
import type { InferenceRequest, NetPort, UsageSink } from '@winsendotai/ovo-contracts';
import { AiSdkInference, type AiSdkInferenceOptions } from '@winsendotai/ovo-plugin-kit';
import { AbortMeteredInference, SpokenCitationsInference } from './aborted-usage.ts';
import { searchAnnouncement, unclearForSearch } from './search-voice.ts';
import { resolveVoiceTuning, type VoiceTuning } from './voice-tuning.ts';
import { webSearchTools, webSearchUsage, type WebSearchConfig } from './web-search.ts';

export interface OpenAiInferenceConfig extends VoiceTuning {
  model: string;
  temperature?: number;
  maxOutputTokens?: number;
  instructions?: string;
  /** OpenAI's built-in web search; off unless `enabled`. Responses API only. */
  webSearch?: WebSearchConfig;
}

export interface OpenAiInferenceSettings {
  /** OVO_LLM_* overrides for fields the binding leaves out; the plugin passes process.env. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Scopes the default prompt cache key, so one binding's turns share a cache. */
  bindingId?: string;
}

export function openAiInference(
  net: NetPort,
  apiKey: string,
  binding: OpenAiInferenceConfig,
  usage?: UsageSink,
  onUsage?: AiSdkInferenceOptions['onUsage'],
  settings: OpenAiInferenceSettings = {},
): AiSdkInference {
  const provider = createOpenAI({
    apiKey,
    fetch: (url, init) =>
      net.fetch(String(url), init ? { ...init, signal: init.signal ?? undefined } : undefined),
  });
  if (
    binding.temperature !== undefined &&
    (!Number.isFinite(binding.temperature) || binding.temperature < 0 || binding.temperature > 2)
  )
    throw new TypeError('OpenAI temperature must be between 0 and 2');
  const model = provider.responses(binding.model);
  const providerTools = webSearchTools(provider, binding.webSearch);
  const Inference = providerTools ? SpokenCitationsInference : AbortMeteredInference;
  const skipUnclear = binding.webSearch?.skipUnclearInput ?? true;
  const announce = searchAnnouncement(binding.webSearch?.announce);
  return new Inference({
    model:
      binding.temperature === undefined
        ? model
        : wrapLanguageModel({
            model,
            middleware: defaultSettingsMiddleware({
              settings: { temperature: binding.temperature },
            }),
          }),
    provider: 'openai',
    maxOutputTokens: binding.maxOutputTokens,
    providerOptions: {
      openai: resolveVoiceTuning(binding.model, binding, settings.env, settings.bindingId),
    },
    instructions: binding.instructions,
    ...(providerTools
      ? {
          providerTools,
          providerToolSources: 'the results of your web search tool',
          providerToolUsage: webSearchUsage,
          ...(skipUnclear
            ? { providerToolsFor: (request: InferenceRequest) => !unclearForSearch(request) }
            : {}),
          ...(announce ? { providerToolAnnounce: announce } : {}),
        }
      : {}),
    usage,
    onUsage,
  });
}
