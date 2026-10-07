import type {
  InferenceReply,
  InferenceRequest,
  InferenceStreamEvent,
  UsageSink,
} from '@winsendotai/ovo-contracts';
import { AiSdkInference, type AiSdkInferenceOptions } from '@winsendotai/ovo-plugin-kit';
import { StreamingCitationStripper, stripCitations } from './web-search.ts';

/** Roughly four characters per token for English and romanised Hindi; an estimate, not a count. */
const CHARS_PER_TOKEN = 4;

/**
 * A request aborted after it was sent is still billed for its input, but the provider reports no
 * usage for it: the stream ends before its `finish`. Barge-in aborts calls, and so does the
 * speculative LLM (LAT-3) whenever the decision answers the turn first. This meters such a call as
 * an `estimated` input count, the same units a reply with no cache hit reports, so the ledger is
 * not silently short. Output and reasoning tokens a provider may also bill are not estimated.
 */
export class AbortMeteredInference extends AiSdkInference {
  private aborted = 0;

  constructor(private readonly metered: AiSdkInferenceOptions) {
    super(metered);
  }

  private clock(): number {
    return this.metered.now?.() ?? Date.now();
  }

  override async generate(request: InferenceRequest): Promise<InferenceReply> {
    const sent = this.sending(request);
    try {
      return await super.generate(request);
    } catch (error) {
      sent?.();
      throw error;
    }
  }

  override async *stream(request: InferenceRequest): AsyncIterable<InferenceStreamEvent> {
    const sent = this.sending(request);
    let finished = false;
    try {
      for await (const event of super.stream(request)) {
        if (event.kind === 'finish') finished = true;
        yield event;
      }
    } finally {
      if (!finished) sent?.();
    }
  }

  /** Meters the request if it ends aborted; undefined when it was aborted before it was sent. */
  private sending(request: InferenceRequest): (() => void) | undefined {
    const usage = this.metered.usage;
    if (!usage || request.signal.aborted) return undefined;
    const startedAt = this.clock();
    return () => {
      if (request.signal.aborted)
        meterAborted(usage, this.provider, request, this.metered.instructions, {
          requestId: `${this.provider}:aborted:${++this.aborted}`,
          elapsedMs: Math.max(0, this.clock() - startedAt),
        });
    };
  }
}

/**
 * Web search answers arrive with inline citations and links. A caller hears the reply, so they are
 * removed here, before the agent's segmenter splits the text and before the TTS filter chain.
 */
export class SpokenCitationsInference extends AbortMeteredInference {
  override async generate(request: InferenceRequest): Promise<InferenceReply> {
    const reply = await super.generate(request);
    return reply.kind === 'text' ? { ...reply, text: stripCitations(reply.text).trim() } : reply;
  }

  override async *stream(request: InferenceRequest): AsyncIterable<InferenceStreamEvent> {
    const stripper = new StreamingCitationStripper();
    for await (const event of super.stream(request)) {
      if (event.kind === 'text-delta') {
        const delta = stripper.push(event.delta);
        if (delta) yield { kind: 'text-delta', delta };
        continue;
      }
      const rest = stripper.finish();
      if (rest) yield { kind: 'text-delta', delta: rest };
      yield event;
    }
    const rest = stripper.finish();
    if (rest) yield { kind: 'text-delta', delta: rest };
  }
}

/** The input an aborted request carried, estimated from everything it sent. */
export function estimateInputTokens(request: InferenceRequest, instructions = ''): number {
  const text = [
    instructions,
    request.context,
    request.uncertainty,
    request.input,
    ...(request.history ?? []).map((entry) => entry.content),
    request.results.length ? JSON.stringify(request.results) : '',
    request.tools.length ? JSON.stringify(request.tools) : '',
  ].join('\n');
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function meterAborted(
  usage: UsageSink,
  provider: string,
  request: InferenceRequest,
  instructions: string | undefined,
  identity: { requestId: string; elapsedMs: number },
): void {
  const quantity = String(estimateInputTokens(request, instructions));
  for (const unit of ['input_tokens', 'uncached_input_tokens'] as const)
    usage({ provider, operation: 'inference', unit, quantity, state: 'estimated', ...identity });
}
