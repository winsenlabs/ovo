import type { Behavior, BehaviorEvent } from '@winsendotai/ovo-contracts';
import type { BoundedSpeechScheduler } from '../scheduler.ts';
import type { TurnLatency } from './latency.ts';
import type { ReplyAudibility } from './turn-audibility.ts';
import { mergeUtterances, type SpeculationHooks } from './turn-speculation.ts';

/** One reply the driver owes: to the caller's words, a key press, the opening or a silence. */
export interface Turn {
  id: string;
  input: string;
  extra: Record<string, unknown>;
  /** Caller speech, which a newer utterance may supersede before it is answered (AGT-10). */
  speech: boolean;
  merged: boolean;
  filler?: { text: string; afterMs: number };
  /** A filler already played for these words (LAT-6): a merged reply never plays a second. */
  fillerPlayed: boolean;
  /**
   * The reply ran a tool. Its effects stand, so it is never superseded or replayed: the caller hears
   * its outcome, and newer words wait behind it.
   */
  committed: boolean;
  /** Set when the turn starts running. */
  controller?: AbortController;
  epoch?: number;
}

export function engineTurn(id: string, input: string, extra: Record<string, unknown>): Turn {
  return { id, input, extra, speech: false, merged: false, fillerPlayed: false, committed: false };
}

/** The caller's words; `filler` is the line the turn detector offers for a slow reply (LAT-6). */
export function callerTurn(id: string, text: string, filler?: Turn['filler']): Turn {
  return { ...engineTurn(id, text, {}), speech: true, ...(filler ? { filler } : {}) };
}

/**
 * The replies the driver owes, in order, and which caller words are still unanswered (AGT-10).
 * When the caller speaks again before hearing any answer to their last words, those words are
 * merged into the newer turn: a turn still queued takes the newer words in place, and a running
 * turn that has made no sound (a filler aside) is superseded, unless it has run a tool.
 */
export class TurnBook {
  running?: Turn;
  private readonly waiting: Turn[] = [];
  private readonly byEpoch = new Map<number, string>();
  /** Caller words whose reply was interrupted while only a filler had played. */
  private carry?: Turn;
  /** Behaviour tools started and not yet settled. */
  private tools = 0;
  private readonly unsubscribe: (() => void)[];

  constructor(
    private readonly audibility: ReplyAudibility,
    private readonly hooks: SpeculationHooks,
    private readonly latency: TurnLatency,
    sources: {
      speech: Pick<BoundedSpeechScheduler, 'subscribe'>;
      behavior: Pick<Behavior, 'subscribe'>;
    },
  ) {
    this.unsubscribe = [
      sources.speech.subscribe((evidence) => audibility.observe(evidence)),
      sources.behavior.subscribe?.((event) => this.tool(event)) ?? (() => undefined),
    ];
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribe) unsubscribe();
  }

  /**
   * The caller's words, as `turn`. Returns the turn to queue (none when a queued turn absorbed
   * them) and the running turn it supersedes, which the caller must cancel.
   */
  caller(turn: Turn): { queue?: Turn; supersede?: Turn } {
    const tail = this.waiting.at(-1);
    if (tail?.speech) {
      this.absorb(turn, tail);
      Object.assign(tail, turn);
      return {};
    }
    let earlier = this.takeCarry();
    let supersede: Turn | undefined;
    const running = this.running;
    if (
      !earlier &&
      running?.speech &&
      !running.committed &&
      !this.tools &&
      !running.controller?.signal.aborted &&
      !this.audibility.answered(running.epoch)
    )
      earlier = supersede = running;
    if (earlier) this.absorb(turn, earlier);
    return supersede ? { queue: turn, supersede } : { queue: turn };
  }

  /** A barge-in cut the running reply; if only a filler had played, its words stay owed. */
  interrupted(): void {
    const running = this.running;
    if (
      running?.speech &&
      !running.committed &&
      running.epoch !== undefined &&
      !this.audibility.answered(running.epoch)
    )
      this.carry = running;
  }

  /** The behaviour's tool lifecycle, for the turn running it. */
  private tool(event: BehaviorEvent): void {
    if (event.type === 'tool.started') {
      this.tools += 1;
      if (this.running) this.running.committed = true;
    } else if (event.type === 'tool.settled') this.tools = Math.max(0, this.tools - 1);
  }

  /** The caller's speech was dropped; words an interruption left unanswered are owed again. */
  reset(turnId: string): Turn | undefined {
    this.hooks.discard(turnId, 'reset');
    return this.takeCarry();
  }

  takeCarry(): Turn | undefined {
    const carry = this.carry;
    this.carry = undefined;
    return carry;
  }

  enqueue(turn: Turn): void {
    this.waiting.push(turn);
  }

  start(turn: Turn): void {
    this.waiting.splice(this.waiting.indexOf(turn), 1);
    this.running = turn;
  }

  /** The turn's reply epoch began: its latency is timed from here. */
  began(turn: Turn, epoch: number): void {
    turn.epoch = epoch;
    this.byEpoch.set(epoch, turn.id);
    this.latency.start(turn.id);
    this.latency.stage(turn.id, 'turn_decision');
  }

  /** P3: the reply moved to a fresh epoch, flushing its filler; both epochs stay the turn's. */
  moved(turn: Turn, epoch: number): void {
    turn.epoch = epoch;
    this.byEpoch.set(epoch, turn.id);
  }

  /**
   * P1: the caller is owed a reply they have not heard any of yet: the running reply to their
   * words (a filler aside), or one still waiting its turn.
   */
  unheard(): boolean {
    const running = this.running;
    if (running?.speech && !running.controller?.signal.aborted)
      return !this.audibility.answered(running.epoch);
    return this.waiting.some((turn) => turn.speech);
  }

  finish(turn: Turn): void {
    if (turn.epoch !== undefined && this.byEpoch.get(turn.epoch) === turn.id) {
      this.latency.total(turn.id);
      this.latency.clear(turn.id);
      for (const [epoch, id] of this.byEpoch) if (id === turn.id) this.byEpoch.delete(epoch);
    }
    if (this.running === turn) this.running = undefined;
  }

  idForEpoch(epoch: number): string | undefined {
    return this.byEpoch.get(epoch);
  }

  abortRunning(reason: string): void {
    this.running?.controller?.abort(new DOMException(reason, 'AbortError'));
  }

  private absorb(turn: Turn, earlier: Turn): void {
    turn.input = mergeUtterances(earlier.input, turn.input);
    turn.merged = true;
    turn.fillerPlayed ||= earlier.fillerPlayed;
    this.hooks.discard(earlier.id, 'superseded');
    // A turn that never ran has no latency of its own to report.
    if (earlier.epoch === undefined) this.latency.clear(earlier.id);
  }
}
