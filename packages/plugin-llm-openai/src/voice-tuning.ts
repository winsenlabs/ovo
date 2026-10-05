import type { OpenAIResponsesProviderOptions } from '@ai-sdk/openai';

export const REASONING_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
export const TEXT_VERBOSITIES = ['low', 'medium', 'high'] as const;
export const SERVICE_TIERS = ['auto', 'default', 'flex', 'priority'] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export type TextVerbosity = (typeof TEXT_VERBOSITIES)[number];
export type ServiceTier = (typeof SERVICE_TIERS)[number];

/** The Responses request settings a voice turn cares about; every field is optional. */
export interface VoiceTuning {
  reasoningEffort?: ReasoningEffort;
  textVerbosity?: TextVerbosity;
  serviceTier?: ServiceTier;
  promptCacheKey?: string;
  store?: boolean;
}

type Environment = Readonly<Record<string, string | undefined>>;

/** `unset` in an env override means "send nothing and let the model use its own default". */
const UNSET = 'unset';

function gptVersion(model: string) {
  const match = /^gpt-(\d+)(?:\.(\d+))?(?:-(.+))?$/.exec(model);
  return match
    ? {
        major: Number(match[1]),
        minor: match[2] === undefined ? undefined : Number(match[2]),
        variant: match[3],
      }
    : undefined;
}

/**
 * The lowest reasoning effort the model accepts, so the first token is not spent thinking.
 * Sources (retrieved 2026-10-06): https://developers.openai.com/api/docs/models/gpt-6-luna
 * (gpt-6-luna: none|low|medium(default)|high|xhigh|max) and
 * https://developers.openai.com/api/docs/guides/latest-model (gpt-6 sol/luna accept `none`, other
 * gpt-6 models start at `low`; no gpt-6 model lists `minimal`). gpt-5 takes `minimal`, gpt-5.1 and
 * later take `none`. Non-reasoning models get nothing.
 */
export function lowestReasoningEffort(model: string): ReasoningEffort | undefined {
  if (/^o\d+(?:-|$)/.test(model)) return 'low';
  const version = gptVersion(model);
  if (!version || version.major < 5) return undefined;
  if (version.minor === undefined && version.variant?.startsWith('chat')) return undefined;
  if (version.major === 5) return version.minor === undefined ? 'minimal' : 'none';
  return model === 'gpt-6-luna' || model === 'gpt-6-sol' ? 'none' : 'low';
}

/**
 * `text.verbosity` is documented for the gpt-5 family only. The gpt-6 pages above do not list it,
 * so it is not sent to gpt-6 by default (UNCONFIRMED: set OVO_LLM_TEXT_VERBOSITY=low to opt in).
 */
export function defaultTextVerbosity(model: string): TextVerbosity | undefined {
  const version = gptVersion(model);
  return version?.major === 5 && !version.variant?.startsWith('chat') ? 'low' : undefined;
}

function choice<T extends string>(
  name: string,
  value: string | undefined,
  allowed: readonly T[],
): T | typeof UNSET | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed === UNSET || (allowed as readonly string[]).includes(trimmed))
    return trimmed as T | typeof UNSET;
  throw new TypeError(`${name} must be one of ${[...allowed, UNSET].join(', ')}`);
}

function flag(name: string, value: string | undefined): boolean | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed === 'true' || trimmed === 'false') return trimmed === 'true';
  throw new TypeError(`${name} must be true or false`);
}

/**
 * Binding fields win, then the OVO_LLM_* env overrides, then the voice defaults: the lowest
 * reasoning effort the model accepts, low verbosity where documented, no stored responses, and a
 * prompt cache key per binding so turns of one agent land on the same cache.
 */
export function resolveVoiceTuning(
  model: string,
  binding: VoiceTuning,
  env: Environment = {},
  bindingId?: string,
): OpenAIResponsesProviderOptions {
  const effort =
    binding.reasoningEffort ??
    choice('OVO_LLM_REASONING_EFFORT', env.OVO_LLM_REASONING_EFFORT, REASONING_EFFORTS);
  const verbosity =
    binding.textVerbosity ??
    choice('OVO_LLM_TEXT_VERBOSITY', env.OVO_LLM_TEXT_VERBOSITY, TEXT_VERBOSITIES);
  const tier =
    binding.serviceTier ?? choice('OVO_LLM_SERVICE_TIER', env.OVO_LLM_SERVICE_TIER, SERVICE_TIERS);
  const reasoningEffort = effort === UNSET ? undefined : (effort ?? lowestReasoningEffort(model));
  const textVerbosity =
    verbosity === UNSET ? undefined : (verbosity ?? defaultTextVerbosity(model));
  const promptCacheKey = binding.promptCacheKey ?? (bindingId ? `ovo:${bindingId}` : undefined);
  return {
    store: binding.store ?? flag('OVO_LLM_STORE', env.OVO_LLM_STORE) ?? false,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(textVerbosity ? { textVerbosity } : {}),
    ...(tier && tier !== UNSET ? { serviceTier: tier } : {}),
    ...(promptCacheKey ? { promptCacheKey } : {}),
  };
}
