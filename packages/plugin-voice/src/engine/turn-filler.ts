import {
  endsConversation,
  expectsShortReply,
  SAID_BEFORE_REPLY_VARIABLE,
  seeksInformation,
  type Clock,
} from '@winsendotai/ovo-contracts';
import type { InferenceActivity } from '@winsendotai/ovo-plugin-kit';
import type { BoundedSpeechScheduler } from '../scheduler.ts';
import type { ReplyAudibility } from './turn-audibility.ts';
import type { Turn } from './turn-book.ts';

/** The reply a filler may still play for: armed, and not yet answered or cancelled. */
interface Armed {
  turn: Turn;
  epoch: number;
  searchAnnounced: boolean;
  timers: (() => void)[];
  /** Cancelled: its reply has a line, or ended. */
  done: boolean;
  /** Filler lines of this turn still queued or playing. */
  playing: number;
  /** When the last of them stopped, or the search started with none playing (call-3 #1). */
  quietAt?: number;
  /** Runs once no filler line is playing. */
  onQuiet?: () => void;
}

/**
 * LAT-6: a caller turn whose reply has made no sound `afterMs` into the turn plays its filler line
 * (a fixed line, so a pre-rendered clip), at most once for the caller's words. A fast reply (the
 * rules tier, a quick decision) produces its first line first, and the caller cancels the timer;
 * a reply whose first line is ready while the filler still plays cuts it (P3, TurnDriver.preempt),
 * and no filler starts while the caller is speaking again (P1).
 * N3: when the provider starts a web search for the reply (`activity`), its search line plays at
 * once in place of a generic filler not yet due, and its "still checking" line once the caller has
 * heard nothing for `stillAfterMs`. Only a turn that searches hears them.
 * Call-3 #1: a turn says at most one filler line up front, never two back to back: a generic
 * filler already started or played leaves the search line unsaid ("One moment. Let me look that
 * up. Still checking, one moment." played on turns 4, 6 and 16 of call 6e1a4e3a), and "still
 * checking" waits for `stillAfterMs` of silence after the last filler line ends.
 * Wave 9 (call 10d5ef30, D6): one filler line per turn in all, "still checking" included: it plays
 * only on a turn that has heard none ("One moment. Still checking, one moment." on turns 13 and
 * 17, "Let me look that up. Still checking, one moment." on turn 17).
 * Wave 10 (call 4f1a919d, L3): no generic filler before a goodbye or a closing, however the reply
 * is composed (`endsConversation`: turn 11, "No, okay, I'll take it later. Thank you so much.",
 * cut "One moment." 0.21 s in), nor before a reply of a few words that cannot search
 * (`Behavior.lookingUp` false): an acknowledgement, a yes or no, thanks or a confirmation
 * (`expectsShortReply`; turn 12 cut it 0.08 s in), or words that only add to words just answered
 * (B1: "Madras.", turn 8, cut 0.88 s in). A yes that accepts an offer to look something up is
 * sent the search, and keeps its filler (call-3 turn 21); so does one whose reply calls one of the
 * agent's own tools, when that call comes (checked every `RECHECK_MS` once the filler is due).
 * `afterMs` runs from when the reply starts being composed: the turn's endpoint decision, or for
 * words queued behind a reply, the end of that reply.
 * The filler is never handed to the behaviour: it is not part of the conversation it records. Its
 * speaking interval is announced as a filler (`bot.started.filler`), so the caller's words over it
 * are taken as in silence rather than as backchannels (AGT-9).
 */
export class TurnFiller {
  private armed?: Armed;
  /** Wave 8: a search the LLM started on the partial transcript, before its turn armed. */
  private early?: InferenceActivity;

  constructor(
    private readonly clock: Pick<Clock, 'setTimeout' | 'now'>,
    private readonly speech: BoundedSpeechScheduler,
    private readonly audibility: ReplyAudibility,
    /** False once the call is ending. */
    private readonly live: () => boolean,
    private readonly failed: (turnId: string, error: unknown) => void,
    /** Wave 9 (D6): the reply's first words are in (`Behavior.drafting`). */
    private readonly drafting: () => boolean = () => false,
    /** Wave 10 (L3): the reply may search (`Behavior.lookingUp`); undefined while unknown. */
    private readonly lookingUp: () => boolean | undefined = () => undefined,
  ) {}

  /**
   * The turn's reply is being composed in `epoch`. Returns the cancel to call once its first line
   * is ready or it ends: it stops the filler timer and any search line still to come.
   */
  arm(turn: Turn, epoch: number): () => void {
    const armed: Armed = {
      turn,
      epoch,
      searchAnnounced: false,
      timers: [],
      done: false,
      playing: 0,
    };
    this.armed = armed;
    const early = this.early;
    this.early = undefined;
    // After this tick's `finalize`, which aborts a call asked on other words.
    if (early)
      queueMicrotask(() => {
        if (this.armed === armed && !early.signal.aborted) this.activity(early);
      });
    const filler = turn.filler;
    if (filler && !turn.fillerPlayed && !endsConversation(turn.input)) {
      const due = () => {
        // Wave 9 (D6): with the reply's first words in, its first line is a few hundred ms away;
        // a filler now would be cut as it starts (call 10d5ef30 turn 22: 180 ms of it).
        if (!this.speakable(armed) || this.drafting()) return;
        // Wave 10 (L3): a few words are on their way, unless the reply turns to a tool meanwhile.
        if (this.lookingUp() === false && shortReply(turn)) {
          armed.timers.push(this.clock.setTimeout(due, RECHECK_MS));
          return;
        }
        turn.fillerPlayed = true;
        this.play(armed, filler.text);
      };
      armed.timers.push(this.clock.setTimeout(due, filler.afterMs));
    }
    return () => {
      armed.done = true;
      armed.onQuiet = undefined;
      for (const cancel of armed.timers.splice(0)) cancel();
      if (this.armed === armed) this.armed = undefined;
    };
  }

  /** A provider tool's progress (N3): a search started for the reply being composed. */
  activity(activity: InferenceActivity): void {
    const armed = this.armed;
    if (activity.phase === 'finished' && this.early?.id === activity.id) this.early = undefined;
    if (activity.phase !== 'started' || !activity.announce || activity.signal.aborted) return;
    if (!armed) {
      this.early = activity;
      return;
    }
    if (armed.searchAnnounced || !this.speakable(armed)) return;
    armed.searchAnnounced = true;
    const { line, stillLine, stillAfterMs } = activity.announce;
    const { turn } = armed;
    // The search line says more than a generic filler: it replaces one not yet due.
    for (const cancel of armed.timers.splice(0)) cancel();
    if (!armed.playing) armed.quietAt ??= this.clock.now();
    // One filler line per turn: after a generic one (or a merged turn's), the search goes unsaid.
    if (line && !turn.fillerPlayed) {
      turn.fillerPlayed = true;
      this.play(armed, line);
    }
    if (stillLine && !turn.fillerPlayed)
      this.after(armed, stillAfterMs, () => {
        if (turn.fillerPlayed) return;
        turn.fillerPlayed = true;
        this.play(armed, stillLine);
      });
  }

  /**
   * Runs `say` once the caller has heard nothing from this turn for `quietMs`: a filler line still
   * playing first ends, and the silence is counted from its end, not from when the search began.
   */
  private after(armed: Armed, quietMs: number, say: () => void): void {
    const check = () => {
      if (armed.done || !this.speakable(armed)) return;
      if (armed.playing) {
        armed.onQuiet = check;
        return;
      }
      const silentMs = this.clock.now() - (armed.quietAt ?? this.clock.now());
      if (silentMs >= quietMs) return say();
      armed.timers.push(this.clock.setTimeout(check, quietMs - silentMs));
    };
    armed.timers.push(this.clock.setTimeout(check, quietMs));
  }

  /** The reply has made no sound, the caller is not speaking, and nothing cancelled it. */
  private speakable({ turn, epoch }: Armed): boolean {
    if (!this.live() || turn.controller?.signal.aborted) return false;
    if (epoch !== this.speech.epoch || this.audibility.answered(epoch)) return false;
    // P1: the caller is speaking again; a filler now would talk over them.
    return !this.speech.held;
  }

  private play(armed: Armed, text: string): void {
    const { turn, epoch } = armed;
    armed.playing += 1;
    const receipt = this.audibility.filler(() =>
      this.speech.speak(text, { epoch, kind: 'acknowledgment' }),
    );
    const ended = () => {
      armed.playing -= 1;
      if (armed.playing) return;
      armed.quietAt = this.clock.now();
      const quiet = armed.onQuiet;
      armed.onQuiet = undefined;
      quiet?.();
    };
    void receipt.then(ended, (error: unknown) => {
      ended();
      this.failed(turn.id, error);
    });
  }
}

/**
 * Wave 10 (L3): how often a due filler held back for a short reply checks again whether the reply
 * has turned to a tool (`Behavior.lookingUp` true), so the caller is not left in silence for it.
 */
const RECHECK_MS = 100;

/** Wave 10 (L3): the reply to `turn` is predictably a few words, so it needs no filler line. */
function shortReply({ input, extra }: Turn): boolean {
  const adds = extra[SAID_BEFORE_REPLY_VARIABLE] !== undefined && !seeksInformation(input);
  return adds || expectsShortReply(input);
}
