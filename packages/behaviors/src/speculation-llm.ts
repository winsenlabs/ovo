import type {
  Inference,
  InferenceReply,
  InferenceRequest,
  InferenceStreamEvent,
} from '@winsendotai/ovo-contracts';

/** What the speculative LLM (LAT-3) did this call, metered apart from the turns that used it. */
export interface LlmSpeculationMetrics {
  /** LLM calls started alongside a decision. */
  started: number;
  /** Calls whose answer the turn spoke: the decision deferred to the LLM. */
  used: number;
  /**
   * Calls aborted because the decision answered the turn (a scripted line, a clarification or a
   * recovery line). The provider still bills their input; its plugin meters that as an estimate.
   */
  aborted: number;
  /** Calls aborted because the turn asked the LLM something else (the flow moved, for example). */
  discarded: number;
}

export type InferenceCall = Omit<InferenceRequest, 'signal'>;

/**
 * LAT-3: the LLM's first step for a turn, asked while the decision model is still deciding, so a
 * turn the decision hands to the LLM does not wait for the two one after the other.
 *
 * Its events are buffered from the start. The turn's own first request takes them when it asks
 * exactly the same thing (`inference()`); a different request aborts this call and asks the LLM
 * itself, so speculation can make a turn faster but never change what it says. A decision that
 * answers the turn aborts it (`abort`).
 */
export class SpeculativeLlm {
  private readonly controller = new AbortController();
  private readonly key: string;
  private state: 'pending' | 'used' | 'aborted' = 'pending';
  private readonly events?: BufferedStream<InferenceStreamEvent>;
  private readonly reply?: Promise<InferenceReply>;

  constructor(
    private readonly llm: Inference,
    call: InferenceCall,
    streaming: boolean,
    turn: AbortSignal,
    private readonly metrics: LlmSpeculationMetrics,
  ) {
    this.key = requestKey(call);
    const abort = () => this.controller.abort(turn.reason);
    turn.addEventListener('abort', abort, { once: true });
    this.controller.signal.addEventListener(
      'abort',
      () => turn.removeEventListener('abort', abort),
      { once: true },
    );
    const request = { ...call, signal: this.controller.signal };
    metrics.started += 1;
    if (streaming && llm.stream) this.events = new BufferedStream(llm.stream(request));
    else {
      this.reply = llm.generate(request);
      // Read by the turn when used; an aborted call's rejection is expected and dropped.
      this.reply.catch(() => undefined);
    }
  }

  /** The decision answered the turn, or the turn ended without asking the LLM. */
  abort(reason = 'the decision answered the turn'): void {
    if (this.state !== 'pending') return;
    this.state = 'aborted';
    this.metrics.aborted += 1;
    this.controller.abort(new DOMException(reason, 'AbortError'));
  }

  /** The LLM as the turn's inference step sees it: its first matching request is this call. */
  inference(): Inference {
    const llm = this.llm;
    const stream = llm.stream;
    return {
      ...(llm.provider ? { provider: llm.provider } : {}),
      ...(llm.model ? { model: llm.model } : {}),
      generate: (request) =>
        this.claim(request, this.reply) ? this.reply! : llm.generate(request),
      ...(stream
        ? {
            stream: (request: InferenceRequest) =>
              this.claim(request, this.events) ? this.events! : stream.call(llm, request),
          }
        : {}),
    };
  }

  /** `answer` is this call's result in the form the step asks for, if it was asked that way. */
  private claim(request: InferenceRequest, answer: unknown): boolean {
    if (this.state !== 'pending') return false;
    if (answer === undefined || requestKey(request) !== this.key) {
      this.state = 'aborted';
      this.metrics.discarded += 1;
      this.controller.abort(
        new DOMException('the turn asked the LLM something else', 'AbortError'),
      );
      return false;
    }
    this.state = 'used';
    this.metrics.used += 1;
    return true;
  }
}

/** Everything the LLM is asked, so two requests compare equal only when they ask the same. */
function requestKey(request: InferenceCall): string {
  const { input, history, context, uncertainty, tools, results } = request;
  return JSON.stringify([input, history ?? [], context, uncertainty, tools, results]);
}

/**
 * Pulls a stream from the moment it is created and replays it to one reader, who may start late.
 * A reader that stops early (a protocol error, a superseded turn) leaves the source to its abort
 * signal, which the turn controls.
 */
class BufferedStream<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = [];
  private finished = false;
  private failure?: { error: unknown };
  private wake?: () => void;

  constructor(source: AsyncIterable<T>) {
    void this.pump(source);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (let index = 0; ;) {
      if (index < this.buffered.length) {
        yield this.buffered[index++]!;
        continue;
      }
      if (this.failure) throw this.failure.error;
      if (this.finished) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }

  private async pump(source: AsyncIterable<T>): Promise<void> {
    try {
      for await (const event of source) {
        this.buffered.push(event);
        this.notify();
      }
    } catch (error) {
      this.failure = { error };
    } finally {
      this.finished = true;
      this.notify();
    }
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
}
