import { generateText, isStepCount, streamText, type LanguageModel, type Tool } from 'ai';
import type {
  Inference,
  InferenceReply,
  InferenceRequest,
  InferenceStreamEvent,
  UsageSink,
  UsageUnit,
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

type ProviderOptions = NonNullable<Parameters<typeof streamText>[0]['providerOptions']>;

/** A tool the provider ran itself inside the step (web search), as the AI SDK reported it. */
export interface ProviderToolResult {
  toolName: string;
  output: unknown;
}

export interface AiSdkInferenceOptions {
  /** Any AI SDK language model. Plugins pass one built with `fetch = ctx.net.fetch`. */
  model: LanguageModel;
  /** Meter provider; defaults to the model's provider prefix (`openai.responses` → `openai`). */
  provider?: string;
  instructions?: string;
  maxOutputTokens?: number;
  /** Per-request provider settings (`{ openai: { reasoningEffort, ... } }`), sent on every step. */
  providerOptions?: ProviderOptions;
  /** v1 evidence callback, kept for existing callers. */
  onUsage?: (evidence: {
    requestId?: string;
    modelId?: string;
    usage: Record<string, number>;
  }) => void | Promise<void>;
  /** v2 token meters (`<provider>.inference.<unit>`), one emission per step. */
  usage?: UsageSink;
  /**
   * Provider-executed tools (`openai.tools.webSearch(...)`), sent alongside the request's OVO tools.
   * The provider runs them inside the step; they never become an OVO tool reply.
   */
  providerTools?: Record<string, Tool>;
  /** Added to the system prompt's factual sources when provider tools can supply facts. */
  providerToolSources?: string;
  /** Per-call meters for the provider tools a step ran, emitted with its token meters. */
  providerToolUsage?: (
    results: readonly ProviderToolResult[],
  ) => readonly { unit: UsageUnit; quantity: number }[];
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
    providerResults: readonly ProviderToolResult[] = [],
  ): Promise<void> {
    if (usage) await this.options.onUsage?.({ requestId, modelId, usage });
    if (!this.options.usage) return;
    const toolMeters = providerResults.length
      ? (this.options.providerToolUsage?.(providerResults) ?? []).filter(
          (meter) => Number.isFinite(meter.quantity) && meter.quantity > 0,
        )
      : [];
    if (!usage && !toolMeters.length) return;
    const id =
      requestId || `${this.provider}:${this.options.sessionId ?? 'session'}:${++this.requests}`;
    const elapsedMs = this.now() - startedAt;
    if (usage)
      for (const meter of tokenMeters(this.provider, usage, id, elapsedMs))
        this.options.usage(meter);
    for (const { unit, quantity } of toolMeters)
      this.options.usage({
        provider: this.provider,
        operation: 'inference',
        unit,
        quantity: String(Math.trunc(quantity)),
        state: 'reconciled',
        requestId: id,
        elapsedMs,
      });
  }

  private stepInput(request: InferenceRequest) {
    const tools = declareTools(request);
    const providerTools = this.options.providerTools ?? {};
    for (const name of Object.keys(providerTools))
      if (Object.hasOwn(tools, name))
        throw new InferenceProtocolError(`Tool ${name} collides with a provider tool`);
    return {
      tools,
      input: {
        model: this.options.model,
        system: buildSystemPrompt(
          request,
          this.options.instructions,
          Object.keys(providerTools).length ? this.options.providerToolSources : undefined,
        ),
        messages: [...(request.history ?? []), { role: 'user' as const, content: request.input }],
        tools: { ...tools, ...providerTools },
        abortSignal: request.signal,
        maxRetries: 0,
        stopWhen: isStepCount(1),
        ...(this.options.maxOutputTokens ? { maxOutputTokens: this.options.maxOutputTokens } : {}),
        ...(this.options.providerOptions ? { providerOptions: this.options.providerOptions } : {}),
      },
    };
  }

  private async generateStep(request: InferenceRequest): Promise<InferenceReply> {
    request.signal.throwIfAborted();
    const startedAt = this.now();
    const { tools: declaredTools, input } = this.stepInput(request);
    const result = await generateText(input);
    request.signal.throwIfAborted();

    // Provider-executed calls (web search) ran inside the step; only OVO calls are replies.
    const toolCalls = result.toolCalls.filter((call) => !call.providerExecuted);
    if (toolCalls.length > 1) {
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
      result.toolResults
        .filter((entry) => entry.providerExecuted)
        .map((entry) => ({ toolName: entry.toolName, output: entry.output })),
    );
    const call = toolCalls[0];
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
    let finished = false;
    let requestId: string | undefined;
    let modelId: string | undefined;
    const providerResults: ProviderToolResult[] = [];

    for await (const part of result.fullStream) {
      request.signal.throwIfAborted();
      if (part.type === 'text-delta' && part.text) {
        if (call)
          throw new InferenceProtocolError('Inference mixed a tool call with response text');
        yield { kind: 'text-delta', delta: part.text };
      } else if (part.type === 'tool-call' && part.providerExecuted) {
        // A provider-executed call (web search) runs inside this step and is never an OVO reply.
        continue;
      } else if (part.type === 'tool-result' && part.providerExecuted) {
        providerResults.push({ toolName: part.toolName, output: part.output });
      } else if (part.type === 'tool-call') {
        // Text then one tool call is a valid step: the agent says its answer and then calls
        // `resume_flow` or `end_call` (AGT-7, AGT-3). The behaviour decides which tool may follow
        // text; a tool call followed by text is still refused below.
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
        await this.report(startedAt, requestId, modelId, usage, providerResults);
        if (call) yield call;
        yield { kind: 'finish', ...(usage ? { usage } : {}) };
        finished = true;
      }
    }
    if (!finished)
      throw new InferenceProtocolError('Inference stream ended without a finish event');
  }
}
