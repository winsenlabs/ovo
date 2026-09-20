import {
  generateText,
  isStepCount,
  jsonSchema,
  tool,
  type Tool,
  type LanguageModelUsage,
} from 'ai';
import type { Inference, InferenceReply, InferenceRequest } from '@winsendotai/ovo-contracts';
import type { AiSdkInferenceOptions } from './types.ts';

export class InferenceProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InferenceProtocolError';
  }
}

/** One provider step with schema-only tools; OVO owns continuation and execution. */
export class AiSdkInference implements Inference {
  constructor(private readonly options: AiSdkInferenceOptions) {}

  async generate(request: InferenceRequest): Promise<InferenceReply> {
    request.signal.throwIfAborted();
    const declaredTools: Record<string, Tool> = Object.fromEntries(
      request.tools.map((definition) => [
        definition.id,
        tool({
          description: definition.description,
          inputSchema: jsonSchema(definition.inputSchema as Parameters<typeof jsonSchema>[0]),
        }),
      ]),
    );

    const result = await generateText({
      model: this.options.model,
      system: buildSystemPrompt(request, this.options.instructions),
      prompt: request.input,
      tools: declaredTools,
      abortSignal: request.signal,
      maxRetries: 0,
      stopWhen: isStepCount(1),
      ...(this.options.maxOutputTokens ? { maxOutputTokens: this.options.maxOutputTokens } : {}),
    });
    request.signal.throwIfAborted();

    if (result.toolCalls.length > 1) {
      throw new InferenceProtocolError(
        'Inference returned multiple tool calls in a single OVO step',
      );
    }
    const usage = compactUsage(result.usage);
    const call = result.toolCalls[0];
    if (call) {
      if (!Object.hasOwn(declaredTools, call.toolName)) {
        throw new InferenceProtocolError(`Inference returned undeclared tool: ${call.toolName}`);
      }
      return {
        kind: 'tool',
        toolId: call.toolName,
        input: call.input,
        ...(usage ? { usage } : {}),
      };
    }
    return { kind: 'text', text: result.text, ...(usage ? { usage } : {}) };
  }
}

function buildSystemPrompt(request: InferenceRequest, instructions?: string): string {
  const sections = [
    instructions?.trim(),
    'Use only the supplied context and completed operation results as factual sources.',
    `When the answer is not supported, respond exactly with: ${request.uncertainty}`,
    `Supplied context:\n${request.context}`,
  ];
  if (request.results.length)
    sections.push(`Completed operation records:\n${JSON.stringify(request.results)}`);
  return sections.filter(Boolean).join('\n\n');
}

// Detail counters are subsets, not extra tokens to add to the totals. Missing
// provider evidence stays missing; it must never become an assumed cache saving.
function compactUsage(usage: LanguageModelUsage): Record<string, number> | undefined {
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
