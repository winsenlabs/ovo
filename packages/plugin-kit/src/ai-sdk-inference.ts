import { generateText, isStepCount, streamText, type LanguageModel } from 'ai';
import type {
  Inference,
  InferenceReply,
  InferenceRequest,
  InferenceStreamEvent,
  UsageSink,
} from '@winsendotai/ovo-contracts';
import {
  InferenceProtocolError,
  buildSystemPrompt,
  compactUsage,
  declareTools,
  describeModel,
  tokenMeters,
} from './ai-sdk-support.ts';

export { InferenceProtocolError } from './ai-sdk-support.ts';

export interface AiSdkInferenceOptions {
  /** Any AI SDK language model. Plugins pass one built with `fetch = ctx.net.fetch`. */
  model: LanguageModel;
  /** Meter provider; defaults to the model's provider prefix (`openai.responses` → `openai`). */
  provider?: string;
  instructions?: string;
  maxOutputTokens?: number;
  /** v1 evidence callback, kept for existing callers. */
  onUsage?: (evidence: {
    requestId?: string;
    modelId?: string;
    usage: Record<string, number>;
  }) => void | Promise<void>;
  /** v2 token meters (`<provider>.inference.<unit>`), one emission per step. */
  usage?: UsageSink;
  /** Used to synthesize a requestId when the provider returns none. */
  sessionId?: string;
  now?: () => number;
}

/** One provider step with schema-only tools; OVO owns continuation and execution. */
export class AiSdkInference implements Inference {
  readonly provider: string;
  readonly model: string;
  private requests = 0;

  constructor(private readonly options: AiSdkInferenceOptions) {
    const described = describeModel(options.model);
    this.provider = options.provider ?? described.provider;
    this.model = described.model;
  }

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

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async report(
    startedAt: number,
    requestId: string | undefined,
    modelId: string | undefined,
    usage: Record<string, number> | undefined,
  ): Promise<void> {
    if (!usage) return;
    await this.options.onUsage?.({ requestId, modelId, usage });
    if (!this.options.usage) return;
    const id =
      requestId || `${this.provider}:${this.options.sessionId ?? 'session'}:${++this.requests}`;
    for (const meter of tokenMeters(this.provider, usage, id, this.now() - startedAt))
      this.options.usage(meter);
  }

  private stepInput(request: InferenceRequest) {
    const tools = declareTools(request);
    return {
      tools,
      input: {
        model: this.options.model,
        system: buildSystemPrompt(request, this.options.instructions),
        messages: [...(request.history ?? []), { role: 'user' as const, content: request.input }],
        tools,
        abortSignal: request.signal,
        maxRetries: 0,
        stopWhen: isStepCount(1),
        ...(this.options.maxOutputTokens ? { maxOutputTokens: this.options.maxOutputTokens } : {}),
      },
    };
  }

  private async generateStep(request: InferenceRequest): Promise<InferenceReply> {
    request.signal.throwIfAborted();
    const startedAt = this.now();
    const { tools: declaredTools, input } = this.stepInput(request);
    const result = await generateText(input);
    request.signal.throwIfAborted();

    if (result.toolCalls.length > 1) {
      throw new InferenceProtocolError(
        'Inference returned multiple tool calls in a single OVO step',
      );
    }
    const usage = compactUsage(result.usage);
    await this.report(
      startedAt,
      result.response.headers?.['x-request-id'] ?? result.response.id,
      result.response.modelId,
      usage,
    );
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
    const startedAt = this.now();
    const { tools: declaredTools, input } = this.stepInput(request);
    const result = streamText(input);
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
        await this.report(startedAt, requestId, modelId, usage);
        if (call) yield call;
        yield { kind: 'finish', ...(usage ? { usage } : {}) };
        finished = true;
      }
    }
    if (!finished)
      throw new InferenceProtocolError('Inference stream ended without a finish event');
  }
}
