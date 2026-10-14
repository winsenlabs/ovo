import {
  continuesUtterance,
  normalizeForMatch,
  SAID_BEFORE_REPLY_VARIABLE,
  UNTRUSTED_INPUT_VARIABLE,
  type Behavior,
  type BehaviorEvent,
  type TranscriptDoubt,
} from '@winsendotai/ovo-contracts';
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
  /** The provider started a web search for its reply (N3): restarting it would search again. */
  searched?: boolean;
  /** The reply has its first line, held or playing: its LLM call has answered (Wave 8b). */
  drafted?: boolean;
  /** Set when the turn starts running. */
  controller?: AbortController;
  epoch?: number;
}

export function engineTurn(id: string, input: string, extra: Record<string, unknown>): Turn {
  return { id, input, extra, speech: false, merged: false, fillerPlayed: false, committed: false };
}

/**
 * The caller's words; `filler` is the line the turn detector offers for a slow reply (LAT-6), and
 * `untrusted` why the detector doubts the words (Wave 8), which the reply's variables carry as
 * `UNTRUSTED_INPUT_VARIABLE` and `inputDoubt`.
 */
export function callerTurn(
  id: string,
  text: string,
  filler?: Turn['filler'],
  untrusted?: TranscriptDoubt,
): Turn {
  const extra = untrusted ? { [UNTRUSTED_INPUT_VARIABLE]: true, inputDoubt: untrusted } : {};
  return { ...engineTurn(id, text, extra), speech: true, ...(filler ? { filler } : {}) };
}

/** Words this short add nothing a reply already searching for the caller must start over for. */
const BRIEF_WORDS = 3;

/**
 * The replies the driver owes, in order, and which caller words are still unanswered (AGT-10).
 * When the caller speaks again before hearing any answer to their last words, those words are
 * merged into the newer turn: a turn still queued takes the newer words in place, and a running
 * turn that has made no sound (a filler aside) is superseded, unless it has run a tool, or it is
 * searching and the newer words are brief (call-3 #1: "Oh, my God." threw away turn 21's search
 * and its answer, and the merged turn searched again, 5.9 s later). Words that carry the earlier
 * ones on are never brief (Wave 8b, call e8a43f65: "Of January." after "…to the 5th."). Words not
 * merged queue behind the reply and are answered after it; when the caller had heard none of that
 * reply, their turn carries the earlier words (`SAID_BEFORE_REPLY_VARIABLE`, Wave 10 B1: "Madras."
 * a second after "Chennai, Chennai.", answered 17.8 s later as if it answered the reply's question).
 */
export class TurnBook {
  running?: Turn;
  private readonly waiting: Turn[] = [];
  private readonly byEpoch = new Map<number, string>();
  /** Caller words whose reply was interrupted while only a filler had played. */
  private carry?: Turn;
  /** The carry is a reply given up for the caller's words still being spoken (`preempt`). */
  private preempted = false;
  /** The reply hold gave up on the caller's open turn (`lapsed`): its words give up no reply. */
  private stuck = false;
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
      const before = tail.extra[SAID_BEFORE_REPLY_VARIABLE];
      this.absorb(turn, tail);
      Object.assign(tail, turn);
      if (before !== undefined)
        tail.extra = { ...tail.extra, [SAID_BEFORE_REPLY_VARIABLE]: before };
      return {};
    }
    let earlier = this.takeCarry();
    let supersede: Turn | undefined;
    const running = this.running;
    if (!earlier && running && this.supersedes(turn.input, running)) earlier = supersede = running;
    if (earlier) this.absorb(turn, earlier);
    else if (running && this.unanswered(running))
      turn.extra = { ...turn.extra, [SAID_BEFORE_REPLY_VARIABLE]: running.input };
    return supersede ? { queue: turn, supersede } : { queue: turn };
  }

  /**
   * Wave 8b (call e8a43f65, issue 4): the caller's words so far, while they still speak. When they
   * will supersede the running reply whatever else they say (they carry its words on, or are more
   * than a brief remark), a reply still composing is given up now rather than when they end, so
   * its LLM call and any web search stop at once (live a superseded turn's search ran on for 1.9
   * and 2.4 s, billed). Its words are carried into the caller's turn, or owed again if that turn
   * comes to nothing or the reply hold gives up on it (`lapsed`). Returns the turn to cancel.
   */
  preempt(words: string): Turn | undefined {
    const running = this.running;
    // A reply with its first line has done the work this saves; the caller's words, once they
    // end, still supersede it (a stuck turn then never holds it past REPLY_HOLD.maxMs).
    if (!running || running.drafted || this.carry || this.stuck) return undefined;
    if (!this.supersedes(words, running)) return undefined;
    if (brief(words) && !continuesUtterance(words, running.input)) return undefined;
    // Wave 12 (call 8cb76efc turn 10): brief words that only repeat the end of the words being
    // answered ("January." after "…to... January.", soft, no VAD run) give up no search.
    if (running.searched && brief(words) && repeatsEnd(words, running.input)) return undefined;
    this.carry = running;
    this.preempted = true;
    return running;
  }

  /** Words `input` merge into `running`, a reply the caller has heard nothing of (AGT-10). */
  private supersedes(input: string, running: Turn): boolean {
    return (
      running.speech &&
      !running.committed &&
      !(running.searched && brief(input) && !continuesUtterance(input, running.input)) &&
      !this.tools &&
      !running.controller?.signal.aborted &&
      !this.audibility.answered(running.epoch)
    );
  }

  /** `running` answers the caller's words, and they have heard none of it yet (a filler aside). */
  private unanswered(running: Turn): boolean {
    return (
      running.speech &&
      !running.controller?.signal.aborted &&
      !this.audibility.answered(running.epoch)
    );
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
    return this.takePreempted() ?? this.takeCarry();
  }

  /**
   * The reply hold gave up on the caller's open turn (REPLY_HOLD `timeout`, `no-words`): a reply
   * given up for its words (`preempt`) is owed now, as the hold promises (P1: never later than
   * `maxMs`), and words the turn goes on with give up no other.
   */
  lapsed(): Turn | undefined {
    const carry = this.takePreempted();
    this.stuck = true;
    return carry;
  }

  takeCarry(): Turn | undefined {
    const carry = this.carry;
    this.carry = undefined;
    this.preempted = false;
    this.stuck = false;
    return carry;
  }

  /**
   * A reply given up for words still being spoken, to run again on its own words, which leave the
   * history it recorded them in (as a merged turn's do) so they are recorded once.
   */
  private takePreempted(): Turn | undefined {
    if (!this.preempted) return undefined;
    const carry = this.takeCarry();
    if (carry) this.hooks.discard(carry.id, 'superseded');
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

  /** N1: a caller turn (words or keys) waits to be answered. */
  callerWaiting(): boolean {
    return this.waiting.some((turn) => turn.speech || turn.extra.inputEvent === 'dtmf');
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

function brief(text: string): boolean {
  return text.split(/\s+/u).filter(Boolean).length <= BRIEF_WORDS;
}

/** `words` say again only the end of `input` (an STT re-emitting its last words). */
function repeatsEnd(words: string, input: string): boolean {
  const said = normalizeForMatch(words);
  return said.length > 0 && normalizeForMatch(input).endsWith(said);
}
