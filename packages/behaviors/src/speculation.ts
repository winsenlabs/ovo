import { normalizeForMatch } from '@winsendotai/ovo-contracts';
import type { DecisionGateResult, DecisionTurn } from './decision-gate.ts';
import { DEFAULT_SPECULATION, type SpeculationPolicy } from './speculation-policy.ts';

export * from './speculation-policy.ts';

/** What speculation on partial transcripts did this call, metered apart from answered turns. */
export interface DecisionSpeculationMetrics {
  /** Decisions started on a partial transcript, rules-only verdicts included. */
  started: number;
  /** Of those, round trips to the decision model: each one is billed whether it is used or not. */
  modelCalls: number;
  /**
   * Verdicts the final transcript took as its own, so the turn asked no decision of its own: a
   * failure it was already waiting on included.
   */
  reused: number;
  /** Verdicts thrown away: the final words or the call's state differed, or the model had failed. */
  discarded: number;
  /** Decisions cancelled before they settled: barge-in, a superseded turn, or the call ending. */
  cancelled: number;
  /**
   * Revisable partials left undecided: cut mid-sentence (`partialEnding: 'sentence'`), or past
   * `maxPartialCalls` for their utterance.
   */
  skipped: number;
}

/**
 * Sentence punctuation an STT puts in a partial: Latin, Devanagari danda, full-width. A `.`, `,`
 * or `:` before a digit is a formatted number, amount or time ("2.5", "3,349", "Rs. 500",
 * "10:30"), which an STT that never punctuates its partials still writes.
 */
const PUNCTUATION = /[?!;।॥。，？！]|[.,:](?!\s?\d)/u;
/** Ends a sentence: a full stop, question or exclamation mark, or danda, then closing quotes. */
const SENTENCE_END = /[.?!।॥。？！]["'”’»)\]]*$/u;
/** A trailing "..." is the STT saying the words trail off, not that the sentence ended. */
const TRAILING = /\.\.["'”’»)\]]*$/u;

/** Whether `text` reads as a finished sentence rather than words cut mid-phrase. */
export function endsSentence(text: string): boolean {
  const trimmed = text.trim();
  return SENTENCE_END.test(trimmed) && !TRAILING.test(trimmed);
}

interface Speculated {
  turnId: string;
  words: string;
  state: string;
  controller: AbortController;
  verdict: Promise<DecisionGateResult>;
  settled: boolean;
}

interface Offer {
  turnId: string;
  turn: DecisionTurn;
  state: string;
  words: string;
  /** Not stable: the STT may still revise the words. */
  revisable: boolean;
}

/**
 * LAT-4: one session's decision on the caller's partial transcript, made before their turn ends
 * and reused when the final transcript says the same, so a confident turn skips the decision
 * model's round trip (~300ms) entirely.
 *
 * A partial the STT may still revise must hold for `debounceMs` before it is decided, and is decided
 * only when it ends a sentence (once the STT is seen punctuating partials) and its utterance has
 * not used up `maxPartialCalls`; a stable one is decided at once. At most one decision is in
 * flight: a newer partial waits for it to settle and then replaces it. `state` is everything else the verdict depends on (flow position, history,
 * variables); a final turn in a different state never reuses it. The verdict is never applied
 * here: the gate returns it to the turn exactly as its own evaluation would, so the turn still
 * commits only what it speaks.
 */
export class DecisionSpeculation {
  private current?: Speculated;
  private offered?: Offer;
  private timer?: ReturnType<typeof setTimeout>;
  /** This call's STT has put punctuation in a revisable partial, so its partials can be read. */
  private punctuated = false;
  /** Model calls made on the revisable partials of utterance `turnId`. */
  private partialCalls = { turnId: '', count: 0 };
  readonly metrics: DecisionSpeculationMetrics = {
    started: 0,
    modelCalls: 0,
    reused: 0,
    discarded: 0,
    cancelled: 0,
    skipped: 0,
  };
  private readonly policy: Pick<
    SpeculationPolicy,
    'debounceMs' | 'match' | 'partialEnding' | 'maxPartialCalls'
  >;

  constructor(
    policy: Pick<SpeculationPolicy, 'debounceMs' | 'match'> &
      Partial<Pick<SpeculationPolicy, 'partialEnding' | 'maxPartialCalls'>>,
    /** The gate's own evaluation, without recording a verdict; returns whether it asked the model. */
    private readonly decide: (
      turn: DecisionTurn,
      signal: AbortSignal,
    ) => { verdict: Promise<DecisionGateResult>; asked: boolean },
  ) {
    this.policy = {
      partialEnding: policy.partialEnding ?? DEFAULT_SPECULATION.partialEnding,
      maxPartialCalls: policy.maxPartialCalls ?? DEFAULT_SPECULATION.maxPartialCalls,
      debounceMs: policy.debounceMs,
      match: policy.match,
    };
  }

  /** A partial transcript of utterance `turnId`. `stable` words skip the debounce. */
  offer(turnId: string, turn: DecisionTurn, state: string, stable: boolean): void {
    const words = normalizeForMatch(turn.input);
    if (!words) return;
    this.clearOffer();
    const current = this.current;
    if (current && current.words === words && current.state === state) return;
    if (!stable && !this.worthDeciding(turnId, turn.input)) {
      this.metrics.skipped += 1;
      return;
    }
    this.offered = { turnId, turn, state, words, revisable: !stable };
    if (stable) this.start();
    else
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.start();
      }, this.policy.debounceMs);
  }

  /**
   * The verdict decided for these words in this state, or undefined (synchronously) to decide now.
   * Whatever is not reused is dropped, and a decision still in flight for other words is cancelled.
   */
  take(
    turn: DecisionTurn,
    state: string,
    signal: AbortSignal,
    waiting?: () => void,
  ): Promise<DecisionGateResult | undefined> | undefined {
    this.clearOffer();
    const entry = this.current;
    this.current = undefined;
    if (!entry) return undefined;
    if (entry.state !== state || !this.matches(entry.words, normalizeForMatch(turn.input))) {
      this.drop(entry, 'superseded by the final transcript');
      return undefined;
    }
    const inFlight = !entry.settled;
    if (inFlight) waiting?.();
    return this.reuse(entry, signal, inFlight);
  }

  private async reuse(
    entry: Speculated,
    signal: AbortSignal,
    inFlight: boolean,
  ): Promise<DecisionGateResult | undefined> {
    // The turn owns the decision now: cancelling the turn cancels it.
    const cancel = () => entry.controller.abort(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const verdict = await entry.verdict;
      // A speculative call that had already failed is no reason to fail the turn: it gets its own
      // full deadline. One the turn waited on is its own: that call started before the turn ended
      // with the same deadline, so asking again would only add a second deadline to the wait.
      if (!inFlight && unavailable(verdict)) {
        this.metrics.discarded += 1;
        return undefined;
      }
      this.metrics.reused += 1;
      return verdict;
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }

  /** The caller's turn has ended: a partial still waiting out its debounce is not decided. */
  closeOffers(): void {
    this.clearOffer();
  }

  /** Utterance `turnId` will not be answered as it was heard: nothing prepared for it survives. */
  discard(turnId: string): void {
    if (this.offered?.turnId === turnId) this.clearOffer();
    const entry = this.current;
    if (entry?.turnId !== turnId) return;
    this.current = undefined;
    this.drop(entry, 'utterance discarded');
  }

  private start(): void {
    const offered = this.offered;
    // At most one in flight: a newer partial starts when the current decision settles.
    if (!offered || (this.current && !this.current.settled)) return;
    this.offered = undefined;
    const controller = new AbortController();
    const { verdict, asked } = this.decide(offered.turn, controller.signal);
    this.metrics.started += 1;
    if (asked) this.metrics.modelCalls += 1;
    if (asked && offered.revisable) this.countPartialCall(offered.turnId);
    const entry: Speculated = { ...offered, controller, verdict, settled: false };
    if (this.current) this.metrics.discarded += 1;
    this.current = entry;
    void verdict.catch(noop).finally(() => {
      entry.settled = true;
      if (this.current === entry && this.offered && this.timer === undefined) this.start();
    });
  }

  /**
   * A revisable partial is decided only when it reads as a finished sentence (as soon as this
   * call's STT has shown it punctuates partials) and its utterance is under `maxPartialCalls`.
   */
  private worthDeciding(turnId: string, text: string): boolean {
    if (PUNCTUATION.test(text)) this.punctuated = true;
    if (this.policy.partialEnding === 'sentence' && this.punctuated && !endsSentence(text))
      return false;
    const used = this.partialCalls.turnId === turnId ? this.partialCalls.count : 0;
    return used < this.policy.maxPartialCalls;
  }

  private countPartialCall(turnId: string): void {
    if (this.partialCalls.turnId !== turnId) this.partialCalls = { turnId, count: 0 };
    this.partialCalls.count += 1;
  }

  private drop(entry: Speculated, reason: string): void {
    if (entry.settled) {
      this.metrics.discarded += 1;
      return;
    }
    this.metrics.cancelled += 1;
    entry.controller.abort(new DOMException(reason, 'AbortError'));
  }

  private clearOffer(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.offered = undefined;
  }

  private matches(prepared: string, final: string): boolean {
    if (prepared === final) return true;
    return this.policy.match === 'prefix' && final.startsWith(`${prepared} `);
  }
}

/** The decision model failed or timed out; a flow reports that inside its fallback step. */
function unavailable(verdict: DecisionGateResult): boolean {
  if (verdict.kind === 'unavailable') return true;
  return verdict.kind === 'flow' && verdict.step.kind === 'fallback' && !!verdict.step.unavailable;
}

function noop(): void {}
