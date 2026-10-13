import {
  callerPunctuation,
  normalizeForMatch,
  type Inference,
  type InferenceReply,
  type InferenceRequest,
  type InferenceStreamEvent,
} from '@winsendotai/ovo-contracts';

/** What the speculative LLM (LAT-3) did this call, metered apart from the turns that used it. */
export interface LlmSpeculationMetrics {
  /** LLM calls started ahead of the turn's own request: alongside a decision, or on a partial. */
  started: number;
  /** Calls whose answer the turn spoke: the decision deferred to the LLM, or the words held. */
  used: number;
  /**
   * Calls aborted because the turn did not ask the LLM (a scripted line, a clarification or a
   * recovery line answered it). The provider still bills their input; its plugin meters that as an
   * estimate.
   */
  aborted: number;
  /**
   * Calls aborted because the turn asked the LLM something else: the flow moved, or the caller's
   * final words or the call's history differed from the partial the call was asked on.
   */
  discarded: number;
  /** Of `started`, the calls asked on the caller's partial transcript (Wave 8). */
  onPartials: number;
}

export type InferenceCall = Omit<InferenceRequest, 'signal'>;

/**
 * Wave 10 (call 4f1a919d, B2): the caller's utterance a call asked ahead of its turn is for, set on
 * its request and on the request's signal (which a provider-run web search reports). The worker's
 * telemetry counts the call and its search on that turn, not on the reply running when it started:
 * live, turn 7 showed two searches, one of them asked for turn 8's "Madras.". A registered symbol,
 * so the worker reads it without importing this package's internals.
 */
export const SPECULATED_UTTERANCE: unique symbol = Symbol.for('ovo.speculation.utterance');

/** The utterance a call was asked ahead for (`SPECULATED_UTTERANCE`), if it was. */
export function speculatedUtterance(carrier: object): string | undefined {
  const value = (carrier as { [SPECULATED_UTTERANCE]?: unknown })[SPECULATED_UTTERANCE];
  return typeof value === 'string' ? value : undefined;
}

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
    /** Aborts the call; a call asked on a partial has no turn until one takes it (`inference`). */
    turn: AbortSignal | undefined,
    private readonly metrics: LlmSpeculationMetrics,
    /** The caller's utterance the call is asked for, ahead of its turn (Wave 10). */
    utterance?: string,
  ) {
    this.key = requestKey(call);
    if (turn) this.follow(turn);
    const signal = this.controller.signal;
    const request: InferenceRequest = { ...call, signal };
    if (utterance !== undefined)
      for (const carrier of [request, signal])
        Object.defineProperty(carrier, SPECULATED_UTTERANCE, { value: utterance });
    metrics.started += 1;
    if (streaming && llm.stream) this.events = new BufferedStream(llm.stream(request));
    else {
      this.reply = llm.generate(request);
      // Read by the turn when used; an aborted call's rejection is expected and dropped.
      this.reply.catch(() => undefined);
    }
  }

  /** Still waiting for a turn to take it or abort it. */
  get pending(): boolean {
    return this.state === 'pending';
  }

  /** The decision answered the turn, or the turn ended without asking the LLM. */
  abort(reason = 'the decision answered the turn'): void {
    if (this.state !== 'pending') return;
    this.state = 'aborted';
    this.metrics.aborted += 1;
    this.controller.abort(new DOMException(reason, 'AbortError'));
  }

  /** Thrown away unasked: the words or the call moved on before a turn could take it. */
  discard(reason: string): void {
    if (this.state !== 'pending') return;
    this.state = 'aborted';
    this.metrics.discarded += 1;
    this.controller.abort(new DOMException(reason, 'AbortError'));
  }

  /** `signal` aborting aborts this call. */
  private follow(signal: AbortSignal): void {
    const abort = () => this.controller.abort(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    this.controller.signal.addEventListener(
      'abort',
      () => signal.removeEventListener('abort', abort),
      { once: true },
    );
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
      this.discard('the turn asked the LLM something else');
      return false;
    }
    this.state = 'used';
    this.metrics.used += 1;
    // The turn owns the call now: cancelling the turn cancels it.
    this.follow(request.signal);
    return true;
  }
}

/**
 * The caller's words as a speculative call is matched on: as `normalizeForMatch` reads them, so a
 * partial and a final transcript that differ only in case or a full stop ask the same, plus the
 * punctuation the inference plugin reads (a question mark or a cut-off decides whether the web
 * search tool is sent): "Is the museum open." is not "Is the museum open?".
 */
export function callerMatchKey(input: string): string {
  return JSON.stringify([normalizeForMatch(input), ...callerPunctuation(input)]);
}

/** Everything the LLM is asked, so two requests compare equal only when they ask the same. */
function requestKey(request: InferenceCall): string {
  const { input, history, context, uncertainty, tools, results } = request;
  return JSON.stringify([
    callerMatchKey(input),
    history ?? [],
    context,
    uncertainty,
    tools,
    results,
  ]);
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
