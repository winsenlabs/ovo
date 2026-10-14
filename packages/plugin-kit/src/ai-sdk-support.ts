import { jsonSchema, tool, type LanguageModel, type LanguageModelUsage, type Tool } from 'ai';
import type { InferenceRequest, UsageMeter, UsageUnit } from '@winsendotai/ovo-contracts';

export class InferenceProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InferenceProtocolError';
  }
}

export function declareTools(request: InferenceRequest): Record<string, Tool> {
  return Object.fromEntries(
    request.tools.map((definition) => [
      definition.id,
      tool({
        description: definition.description,
        inputSchema: jsonSchema(definition.inputSchema as Parameters<typeof jsonSchema>[0]),
      }),
    ]),
  );
}

export function buildSystemPrompt(
  request: InferenceRequest,
  instructions?: string,
  /** Further factual sources the model may use, e.g. a provider's web search results. */
  extraSources?: string,
  /** How to use those sources (a provider tool's instructions); sent only with them. */
  extraInstructions?: string,
): string {
  const sources = extraSources?.trim()
    ? `the supplied context, completed operation results and ${extraSources.trim()}`
    : 'the supplied context and completed operation results';
  const sections = [
    instructions?.trim(),
    `Use only ${sources} as factual sources.`,
    extraSources?.trim() ? extraInstructions?.trim() : undefined,
    `When the caller asks for a fact these sources do not support, respond exactly with: ${request.uncertainty}`,
    // call-3 #3: the uncertainty line was the model's answer to "हाँ।" and to words the noise cut.
    // Wave 12 (Maya call 8cb76efc, F1): "ask for nothing: ask the caller to say it again" had the
    // model ask that of "Jan 12th, 2024.", said for the dates it had asked, and of a "Yeah." to
    // its own offer, and "Could you finish your question?" of words cut off mid-sentence.
    'Never give that line to words that ask for no fact. When the caller tells you their plans ' +
      'or dates, answers your question, or says yes to what you offered, carry on from what they ' +
      'said. When their words break off unfinished, answer what they did ask, or invite them to go ' +
      'on in a few words. Ask them to say it again only when you cannot make out their words.',
    `Supplied context:\n${request.context}`,
  ];
  if (request.results.length)
    sections.push(`Completed operation records:\n${JSON.stringify(request.results)}`);
  return sections.filter(Boolean).join('\n\n');
}

// Detail counters are subsets, not extra tokens to add to the totals. Missing
// provider evidence stays missing; it must never become an assumed cache saving.
export function compactUsage(usage: LanguageModelUsage): Record<string, number> | undefined {
  const values = Object.entries({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    uncachedInputTokens: usage.inputTokenDetails.noCacheTokens,
    cacheReadInputTokens: usage.inputTokenDetails.cacheReadTokens,
    cacheWriteInputTokens: usage.inputTokenDetails.cacheWriteTokens,
    textOutputTokens: usage.outputTokenDetails.textTokens,
    reasoningOutputTokens: usage.outputTokenDetails.reasoningTokens,
  }).filter(
    (entry): entry is [string, number] =>
      typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 0,
  );
  return values.length ? Object.fromEntries(values) : undefined;
}

/** Compact usage fields that become token meters (`openai.inference.*_tokens`). */
const METERED_UNITS: readonly (readonly [string, UsageUnit])[] = [
  ['inputTokens', 'input_tokens'],
  ['uncachedInputTokens', 'uncached_input_tokens'],
  ['cacheReadInputTokens', 'cache_read_input_tokens'],
  ['cacheWriteInputTokens', 'cache_write_input_tokens'],
  ['outputTokens', 'output_tokens'],
];

/** One reconciled meter per reported token counter. Provider-reported counts are never estimates. */
export function tokenMeters(
  provider: string,
  usage: Record<string, number>,
  requestId: string,
  elapsedMs: number,
): UsageMeter[] {
  return METERED_UNITS.filter(([field]) => typeof usage[field] === 'number').map(
    ([field, unit]) => ({
      provider,
      operation: 'inference',
      unit,
      quantity: String(Math.trunc(usage[field]!)),
      state: 'reconciled',
      requestId,
      elapsedMs,
    }),
  );
}

/** `{provider, model}` of an AI SDK model; `openai.responses` → `openai`, `openai/gpt-4o` → `openai`. */
export function describeModel(model: LanguageModel): { provider: string; model: string } {
  if (typeof model === 'string') {
    const [provider, ...rest] = model.split('/');
    return { provider: rest.length ? provider! : 'gateway', model: model };
  }
  return { provider: model.provider.split('.')[0] || model.provider, model: model.modelId };
}
