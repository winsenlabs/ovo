import {
  normalizeForMatch,
  seeksInformation,
  type Inference,
  type InferenceRequest,
} from '@winsendotai/ovo-contracts';

/**
 * A provider-run tool's progress as an inference port reports it (plugin-kit `InferenceActivity`,
 * read structurally: behaviours do not depend on the kit).
 */
type Activity = { tool: string; id: string; signal: AbortSignal } & (
  | { phase: 'started' }
  | { phase: 'finished'; outcome: 'succeeded' | 'failed' | 'cancelled'; results?: number }
);

interface ActivitySource {
  observeActivity(listener: (activity: Activity) => void): () => void;
}

interface Search {
  id: string;
  /** The caller's words the request that searched was asked on, normalised. */
  words: string;
  signal: AbortSignal;
  /** The search failed or found nothing: it does not count. */
  empty: boolean;
  /** Its results came back (before any abort). */
  returned: boolean;
  /** Asked ahead on the caller's partial words, which their turn then holds. */
  ahead: boolean;
  /** The turn it was started in (`SearchBudget.turns`). */
  turn: number;
}

/**
 * What `outer` says beyond `inner`, when it holds `inner` as whole words ("yeah dude that s why"
 * holds "yeah dude"); undefined when it does not.
 */
function beyond(outer: string, inner: string): string | undefined {
  if (!inner) return undefined;
  const padded = ` ${outer} `;
  const at = padded.indexOf(` ${inner} `);
  if (at < 0) return undefined;
  return `${padded.slice(0, at)} ${padded.slice(at + inner.length + 2)}`.trim();
}

/**
 * Wave 9 (Maya call 10d5ef30, D8): at most one web search for the caller's words, unless it found
 * nothing. A request asked on them that searched and was thrown away (asked ahead on a partial
 * the caller went on from, or a reply AGT-10 superseded) was still billed; live, each was followed
 * by a second search for words that held the first's (69.1 and 75.0 s, 104.3 and 109.8 s, 248.9 and
 * 253.7 s). Later requests whose words hold those, in the same turn or the one that takes them
 * over, are sent no provider tools (`InferenceRequest.providerTools`), with one exception: a reply
 * AGT-10 superseded before its search came back found the caller nothing, so the merged turn may
 * search when its newer words ask something new ("Yeah, December 26." then "…Can you tell me about
 * how pricey flights are?"). A partial's words are the turn's own: its search is the turn's. The
 * model is not otherwise restricted: a turn of new words searches as before.
 */
export class SearchBudget {
  private searches: Search[] = [];
  /** Turns begun. */
  private turns = 0;
  /** The words of each request in flight, by its signal, and whether it was asked ahead. */
  private readonly asked = new WeakMap<AbortSignal, { words: string; ahead: boolean }>();
  private readonly unsubscribe?: () => void;

  constructor(inference: Inference) {
    const source = inference as Partial<ActivitySource>;
    if (typeof source.observeActivity === 'function')
      this.unsubscribe = source.observeActivity((activity) => this.activity(activity));
  }

  /**
   * `inference`, its requests limited by the budget; `ahead` for the calls asked on the caller's
   * partial transcript (LAT-4).
   */
  limit(inference: Inference, ahead = false): Inference {
    const limited = <T extends Omit<InferenceRequest, 'signal'>>(request: T): T =>
      this.allows(request.input) ? request : { ...request, providerTools: false };
    const ask = (request: InferenceRequest): InferenceRequest => {
      this.asked.set(request.signal, { words: normalizeForMatch(request.input), ahead });
      return limited(request);
    };
    // Read through at each use, as the port stands then (a test may swap its methods).
    return {
      get provider() {
        return inference.provider;
      },
      get model() {
        return inference.model;
      },
      generate: (request) => inference.generate(ask(request)),
      get stream() {
        const stream = inference.stream;
        return stream && ((request: InferenceRequest) => stream.call(inference, ask(request)));
      },
      get sendsProviderTools() {
        const sends = inference.sendsProviderTools;
        return (
          sends &&
          ((request: Omit<InferenceRequest, 'signal'>) => sends.call(inference, limited(request)))
        );
      },
    };
  }

  /**
   * Whether a request on the caller's `input` may still search: no search for words it holds was
   * started in this turn, or in the turn before by a request since thrown away. One a reply used
   * is spent with that reply ("Yes." to "Shall I check the flights?" searched; "Yes, and hotels"
   * may search again).
   */
  allows(input: string): boolean {
    const words = normalizeForMatch(input);
    return !this.searches.some((search) => {
      if (search.empty || (search.turn !== this.turns && !search.signal.aborted)) return false;
      const more = beyond(words, search.words);
      if (more === undefined) return false;
      return search.returned || search.ahead || !seeksInformation(more);
    });
  }

  /** A turn begins: searches from before the last one no longer count. */
  beginTurn(): void {
    this.turns += 1;
    this.searches = this.searches.filter((search) => this.turns - search.turn <= 1);
  }

  dispose(): void {
    this.unsubscribe?.();
  }

  private activity(activity: Activity): void {
    if (activity.phase === 'started') {
      const asked = this.asked.get(activity.signal);
      if (!asked || this.searches.some((search) => search.id === activity.id)) return;
      this.searches.push({
        id: activity.id,
        ...asked,
        signal: activity.signal,
        empty: false,
        returned: false,
        turn: this.turns,
      });
      return;
    }
    const search = this.searches.find((entry) => entry.id === activity.id);
    if (!search) return;
    if (activity.outcome === 'failed' || activity.results === 0) search.empty = true;
    else if (activity.outcome === 'succeeded') search.returned = true;
  }
}
