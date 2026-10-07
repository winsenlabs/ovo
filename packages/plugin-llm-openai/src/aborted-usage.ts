import type {
  InferenceReply,
  InferenceRequest,
  InferenceStreamEvent,
  UsageSink,
} from '@winsendotai/ovo-contracts';
import {
  AiSdkInference,
  type AiSdkInferenceOptions,
  type InferenceActivity,
} from '@winsendotai/ovo-plugin-kit';
import { StreamingCitationStripper, stripCitations, WEB_SEARCH_TOOL } from './web-search.ts';

/** Roughly four characters per token for English and romanised Hindi; an estimate, not a count. */
const CHARS_PER_TOKEN = 4;

/**
 * N6: what a request with OpenAI's web search tool carries beyond what OVO sends, before any
 * request of the call has reported its usage. Maya call 50ac3860 (2026-10-07): the first aborted
 * request was estimated at 389 tokens from its text, the next completed one, a few words longer,
 * reported 4,827 (4,725 of them cached). The difference is the hosted tool's own instructions and
 * the request scaffolding. Replaced by the call's own figure once one request has reported.
 */
export const WEB_SEARCH_SCAFFOLD_TOKENS = 4_400;

/**
 * N6: a search-enabled request aborted this long after it was sent is metered one search when
 * nothing streamed could say whether it searched (`generate`). A stream reports each search as it
 * starts, before it runs, so a stream is metered exactly the searches it started.
 */
export const ABORTED_SEARCH_AFTER_MS = 1_500;

/** What one request reported beyond its own text, by whether it was sent the provider tools. */
interface Calibration {
  overhead: number;
  cached: number;
}

/**
 * A request aborted after it was sent is still billed for its input, but the provider reports no
 * usage for it: the stream ends before its `finish`. Barge-in aborts calls, and so does the
 * speculative LLM (LAT-3) whenever the decision answers the turn first. This meters such a call as
 * `estimated` input, and any web search it started (N6), so the ledger is not silently short.
 * The input is its text plus what the call's last fully reported request carried beyond its text
 * (system scaffolding, tool schemas, the web search tool's instructions), split into cached and
 * uncached as that request was. Output and reasoning tokens a provider may also bill are not
 * estimated.
 */
export class AbortMeteredInference extends AiSdkInference {
  private aborted = 0;
  private readonly calibrated = new Map<boolean, Calibration>();
  /** Web searches started per request signal, for as long as the signal lives. */
  private readonly searches = new WeakMap<AbortSignal, number>();

  constructor(private readonly metered: AiSdkInferenceOptions) {
    super(metered);
    this.observeActivity((activity) => this.countSearch(activity));
  }

  private clock(): number {
    return this.metered.now?.() ?? Date.now();
  }

  override async generate(request: InferenceRequest): Promise<InferenceReply> {
    const sent = this.sending(request, false);
    try {
      const reply = await super.generate(request);
      // A generated reply does not say whether it searched; only a request without the tool teaches.
      if (!this.sendsProviderTools(request)) this.calibrate(request, reply.usage);
      return reply;
    } catch (error) {
      sent?.();
      throw error;
    }
  }

  override async *stream(request: InferenceRequest): AsyncIterable<InferenceStreamEvent> {
    const sent = this.sending(request, true);
    const before = this.searched(request.signal);
    let finished = false;
    try {
      for await (const event of super.stream(request)) {
        if (event.kind === 'finish') {
          finished = true;
          // Search results are input too; only a request that did not search shows the overhead.
          if (this.searched(request.signal) === before) this.calibrate(request, event.usage);
        }
        yield event;
      }
    } finally {
      if (!finished) sent?.(this.searched(request.signal) - before);
    }
  }

  private searched(signal: AbortSignal): number {
    return this.searches.get(signal) ?? 0;
  }

  /** A started call is counted as a search until it reports another action (page opens are free). */
  private countSearch(activity: InferenceActivity): void {
    if (activity.tool !== WEB_SEARCH_TOOL) return;
    const count = this.searched(activity.signal);
    if (activity.phase === 'started') this.searches.set(activity.signal, count + 1);
    else if (activity.action !== undefined && activity.action !== 'search')
      this.searches.set(activity.signal, Math.max(0, count - 1));
  }

  private calibrate(request: InferenceRequest, usage: Record<string, number> | undefined): void {
    const input = usage?.inputTokens;
    if (input === undefined) return;
    const instructions = this.metered.instructions;
    this.calibrated.set(this.sendsProviderTools(request), {
      overhead: Math.max(0, input - estimateInputTokens(request, instructions)),
      cached: Math.min(input, usage?.cacheReadInputTokens ?? 0),
    });
  }

  /** Meters the request if it ends aborted; undefined when it was aborted before it was sent. */
  private sending(request: InferenceRequest, streamed: boolean) {
    const usage = this.metered.usage;
    if (!usage || request.signal.aborted) return undefined;
    const startedAt = this.clock();
    const tools = this.sendsProviderTools(request);
    return (searches = 0) => {
      if (!request.signal.aborted) return;
      const elapsedMs = Math.max(0, this.clock() - startedAt);
      const calibration = this.calibrated.get(tools) ?? {
        overhead: tools ? WEB_SEARCH_SCAFFOLD_TOKENS : 0,
        cached: 0,
      };
      const guessed = tools && !streamed && elapsedMs >= ABORTED_SEARCH_AFTER_MS ? 1 : 0;
      meterAborted(usage, this.provider, {
        input: estimateInputTokens(request, this.metered.instructions) + calibration.overhead,
        cached: calibration.cached,
        searches: tools ? Math.max(searches, guessed) : 0,
        requestId: `${this.provider}:aborted:${++this.aborted}`,
        elapsedMs,
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

/** The text an aborted request carried, estimated from everything OVO sent. */
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
  estimate: {
    input: number;
    cached: number;
    searches: number;
    requestId: string;
    elapsedMs: number;
  },
): void {
  const { requestId, elapsedMs } = estimate;
  const cached = Math.min(estimate.cached, estimate.input);
  const meter = (unit: Parameters<UsageSink>[0]['unit'], quantity: number) =>
    usage({
      provider,
      operation: 'inference',
      unit,
      quantity: String(quantity),
      state: 'estimated',
      requestId,
      elapsedMs,
    });
  meter('input_tokens', estimate.input);
  meter('uncached_input_tokens', estimate.input - cached);
  if (cached) meter('cache_read_input_tokens', cached);
  if (estimate.searches) meter('web_search_calls', estimate.searches);
}
