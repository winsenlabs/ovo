import type {
  Inference,
  InferenceReply,
  InferenceRequest,
  InferenceStreamEvent,
  UsageMeter,
  UsageSink,
} from '@winsendotai/ovo-contracts';

export type ScriptedReply =
  | InferenceReply
  | ((request: InferenceRequest, index: number) => InferenceReply | Promise<InferenceReply>);

export interface ScriptedInference extends Inference {
  readonly provider: string;
  readonly model: string;
  readonly requests: readonly InferenceRequest[];
}

/**
 * An Inference that replays replies in order (the last one repeats). Token usage (input = input
 * characters, output = reply characters) goes to `usage` with a synthesized requestId.
 */
export function createScriptedInference(
  replies: readonly ScriptedReply[],
  options: { provider?: string; model?: string; usage?: UsageSink; sessionId?: string } = {},
): ScriptedInference {
  const provider = options.provider ?? 'scripted';
  const requests: InferenceRequest[] = [];
  const next = async (request: InferenceRequest): Promise<InferenceReply> => {
    request.signal.throwIfAborted();
    requests.push(request);
    const index = requests.length - 1;
    const scripted = replies[Math.min(index, replies.length - 1)];
    if (!scripted) return { kind: 'text', text: '' };
    const reply = typeof scripted === 'function' ? await scripted(request, index) : scripted;
    const meter = (unit: UsageMeter['unit'], quantity: number): UsageMeter => ({
      provider,
      operation: 'inference',
      unit,
      quantity: String(quantity),
      state: 'reconciled',
      requestId: `${provider}:${options.sessionId ?? 'session'}:${index + 1}`,
      elapsedMs: 0,
    });
    options.usage?.(meter('input_tokens', request.input.length));
    options.usage?.(
      meter(
        'output_tokens',
        reply.kind === 'text' ? reply.text.length : JSON.stringify(reply.input).length,
      ),
    );
    return reply;
  };
  return {
    provider,
    model: options.model ?? 'scripted-1',
    requests,
    generate: next,
    async *stream(request): AsyncIterable<InferenceStreamEvent> {
      const reply = await next(request);
      if (reply.kind === 'tool') yield { kind: 'tool', toolId: reply.toolId, input: reply.input };
      else for (const word of reply.text.split(/(?<= )/)) yield { kind: 'text-delta', delta: word };
      yield { kind: 'finish' };
    },
  };
}
