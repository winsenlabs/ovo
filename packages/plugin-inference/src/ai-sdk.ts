import {
  generateText,
  isStepCount,
  jsonSchema,
  streamText,
  tool,
  type Tool,
  type LanguageModelUsage,
} from 'ai';
import type {
  Inference,
  InferenceReply,
  InferenceRequest,
  InferenceStreamEvent,
} from '@winsendotai/ovo-contracts';
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
    try {
      return await this.generateStep(request);
    } catch (error) {
      if (request.signal.aborted) throw new DOMException('Inference cancelled', 'AbortError');
      if (error instanceof InferenceProtocolError) throw error;
      // SDK errors can retain request headers, bodies and credential fragments.
      throw new InferenceProtocolError('Inference provider request failed');
    }
  }

  async *stream(request: InferenceRequest): AsyncIterable<InferenceStreamEvent> {
    try {
      yield* this.streamStep(request);
    } catch (error) {
      if (request.signal.aborted) throw new DOMException('Inference cancelled', 'AbortError');
      if (error instanceof InferenceProtocolError) throw error;
      // Streaming SDK errors may also retain headers, bodies and credentials.
      throw new InferenceProtocolError('Inference provider request failed');
    }
  }

  private async generateStep(request: InferenceRequest): Promise<InferenceReply> {
    request.signal.throwIfAborted();
    const declaredTools = declareTools(request);

    const result = await generateText({
      model: this.options.model,
      system: buildSystemPrompt(request, this.options.instructions),
      messages: [...(request.history ?? []), { role: 'user', content: request.input }],
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
    if (usage)
      await this.options.onUsage?.({
        requestId: result.response.headers?.['x-request-id'] ?? result.response.id,
        modelId: result.response.modelId,
        usage,
      });
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

  private async *streamStep(request: InferenceRequest): AsyncIterable<InferenceStreamEvent> {
    request.signal.throwIfAborted();
    const declaredTools = declareTools(request);
    const result = streamText({
      model: this.options.model,
      system: buildSystemPrompt(request, this.options.instructions),
      messages: [...(request.history ?? []), { role: 'user', content: request.input }],
      tools: declaredTools,
      abortSignal: request.signal,
      maxRetries: 0,
      stopWhen: isStepCount(1),
      ...(this.options.maxOutputTokens ? { maxOutputTokens: this.options.maxOutputTokens } : {}),
    });
    let call: { kind: 'tool'; toolId: string; input: unknown } | undefined;
    let emittedText = false;
    let finished = false;
    let requestId: string | undefined;
    let modelId: string | undefined;

    for await (const part of result.fullStream) {
      request.signal.throwIfAborted();
      if (part.type === 'text-delta' && part.text) {
        if (call)
          throw new InferenceProtocolError('Inference mixed a tool call with response text');
        emittedText = true;
        yield { kind: 'text-delta', delta: part.text };
      } else if (part.type === 'tool-call') {
        if (emittedText)
          throw new InferenceProtocolError('Inference mixed response text with a tool call');
        if (call)
          throw new InferenceProtocolError(
            'Inference returned multiple tool calls in a single OVO step',
          );
        if (!Object.hasOwn(declaredTools, part.toolName))
          throw new InferenceProtocolError(`Inference returned undeclared tool: ${part.toolName}`);
        call = { kind: 'tool', toolId: part.toolName, input: part.input };
      } else if (part.type === 'finish-step') {
        requestId = part.response.headers?.['x-request-id'] ?? part.response.id;
        modelId = part.response.modelId;
      } else if (part.type === 'error') {
        throw part.error;
      } else if (part.type === 'abort') {
        throw new DOMException('Inference cancelled', 'AbortError');
      } else if (part.type === 'finish') {
        const usage = compactUsage(part.totalUsage);
        if (usage) await this.options.onUsage?.({ requestId, modelId, usage });
        if (call) yield call;
        yield { kind: 'finish', ...(usage ? { usage } : {}) };
        finished = true;
      }
    }
    if (!finished)
      throw new InferenceProtocolError('Inference stream ended without a finish event');
  }
}

function declareTools(request: InferenceRequest): Record<string, Tool> {
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
