import type {
  Behavior,
  Clock,
  MediaDuplex,
  SessionInput,
  TurnSpeculation,
} from '@winsendotai/ovo-contracts';
import type { InferenceActivity } from '@winsendotai/ovo-plugin-kit';
import type { BoundedSpeechScheduler } from '../scheduler.ts';
import { realClock } from './clock.ts';
import type { VoiceEventBus } from './events.ts';
import { IdleWatch } from './idle-watch.ts';
import { SpeechReceipts } from './speech-receipts.ts';
import type { TurnLatency } from './latency.ts';
import { describeError, logVoiceEvent } from './log.ts';
import { ReplyAudibility } from './turn-audibility.ts';
import { callerTurn, engineTurn, TurnBook, type Turn } from './turn-book.ts';
import { TurnFiller } from './turn-filler.ts';
import { ReplyHold } from './turn-hold.ts';
import { ReplyEpoch } from './turn-preempt.ts';
import { speakReply } from './turn-reply.ts';
import { withCallVariables } from './turn-call-variables.ts';
import { completionEnd, type DriverEndReason } from './turn-completion.ts';
import { SpeculationHooks } from './turn-speculation.ts';

/**
 * Runs the replies a TurnDriver owes, one at a time: each in its own speech epoch, with its filler,
 * receipts and speculation hooks, and AGT-10's merging of caller words that were never answered.
 */
export abstract class TurnRunner {
  protected readonly receipts: SpeechReceipts;
  protected readonly tasks = new Set<Promise<void>>();
  protected interrupting: Promise<unknown> = Promise.resolve();
  private serial: Promise<void> = Promise.resolve();
  protected stopped = false;
  /** Set once the call is closing (an answering machine, the time limit); no new turn starts. */
  protected closing = false;
  protected readonly turns: TurnBook;
  private readonly filler: TurnFiller;
  /** Set when the behaviour handles silence; the turn detector's idle prompts are then ignored. */
  protected readonly idle?: IdleWatch;
  private readonly audibility = new ReplyAudibility();
  protected readonly hooks: SpeculationHooks;
  /** P1: holds an unheard reply while the caller speaks again. */
  protected readonly hold: ReplyHold;
  /** The caller turn the detector has open, from its start to its stop or reset. */
  protected callerOpen?: string;
  /** N1: the behaviour completed while the caller was talking; set to the turn's extra. */
  private endDeferred?: Readonly<Record<string, unknown>>;

  turnIdForEpoch = (epoch: number): string | undefined => this.turns.idForEpoch(epoch);
  /** For SpeechEventProjector: a LAT-6 filler line opens no answer the caller must wait out. */
  isFiller = (segmentId: string): boolean => this.audibility.isFiller(segmentId);

  constructor(
    protected readonly behavior: Behavior & TurnSpeculation,
    protected readonly speech: BoundedSpeechScheduler,
    protected readonly session: SessionInput,
    protected readonly events: VoiceEventBus,
    protected readonly latency: TurnLatency,
    protected readonly end: (reason: DriverEndReason, detail?: string) => void,
    private readonly maxConcurrentTurns: number,
    protected readonly media: MediaDuplex,
    protected readonly clock: Pick<Clock, 'setTimeout'> = realClock,
  ) {
    this.receipts = new SpeechReceipts(
      behavior,
      media,
      session,
      (error) => {
        this.log('speech_receipt_failed', error);
        this.stopped = true;
        this.turns.abortRunning('speech receipt failed');
        this.end('error:turn');
      },
      () => {
        // P4: a final goodbye (a flow's end node, an opt-out) the caller cut after hearing part of
        // it completes the call on that receipt: hang up now, not after the caller's next turn.
        if (!this.stopped && !this.closing && this.behavior.isComplete?.())
          this.end(...completionEnd(this.behavior, {}));
      },
    );
    this.idle = IdleWatch.for(behavior, clock, events, {
      quiet: () => !this.stopped && !this.closing && !this.tasks.size,
      run: (turnId) => this.queue(engineTurn(turnId, '', { inputEvent: 'idle' })),
    });
    // The call's variables ride on each partial, as its turn will get them.
    this.hooks = new SpeculationHooks(withCallVariables(behavior, session), (hook, e) =>
      this.log('speculation_hook_failed', e, { hook }, 'warn'),
    );
    this.turns = new TurnBook(this.audibility, this.hooks, latency, { speech, behavior });
    this.filler = new TurnFiller(
      clock,
      speech,
      this.audibility,
      () => !this.stopped && !this.closing,
      (turnId, error) => this.log('filler_failed', error, { turnId }, 'warn'),
    );
    const unheard = () => this.turns.unheard();
    this.hold = new ReplyHold(clock, speech, events, unheard, media.sessionId);
  }

  /** N3: a provider tool's progress inside the reply being composed (a web search starting). */
  inferenceActivity(activity: InferenceActivity): void {
    this.filler.activity(activity);
  }

  async dispose(): Promise<void> {
    this.stopped = true;
    this.hold.dispose();
    this.idle?.dispose();
    this.turns.dispose();
    this.turns.abortRunning('engine disposed');
    this.behavior.cancel?.();
    await Promise.allSettled([...this.tasks, ...this.receipts.inFlight()]);
  }

  /**
   * AGT-10: the caller spoke again before hearing any answer to their last words. The reply still
   * waiting or being composed for them is abandoned (its decision, LLM and TTS work cancelled, its
   * speech never played) and one reply answers both, newest words last.
   */
  protected caller(id: string, text: string, filler: Turn['filler']): void {
    const { queue, supersede } = this.turns.caller(callerTurn(id, text, filler));
    if (supersede) {
      supersede.controller?.abort(new DOMException('turn superseded', 'AbortError'));
      this.behavior.cancel?.();
      // Flushes the stale reply's queued lines and its synthesis before any audio reaches the caller.
      if (supersede.epoch !== undefined) this.interrupting = this.speech.beginEpoch();
    }
    if (queue) this.queue(queue);
  }

  /** Keeps `task` until it settles, so disposal waits for it. */
  protected track(task: Promise<void>): void {
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task));
  }

  /** The call is closing: no turn starts, and the running one and any held reply are dropped. */
  protected cutOff(reason: string): void {
    this.closing = true;
    this.hold.release('closing');
    this.turns.abortRunning(reason);
    this.behavior.cancel?.();
  }

  protected queue(turn: Turn): void {
    if (this.tasks.size >= this.maxConcurrentTurns) {
      this.end('error:turn');
      return;
    }
    this.turns.enqueue(turn);
    // swallow-ok: the earlier turn's own task.catch below ends the call; this only orders turns.
    const previous = this.serial.catch(() => undefined);
    const task = previous.then(() => {
      // A turn that runs decides afresh whether the call ends.
      this.endDeferred = undefined;
      this.turns.start(turn);
      return this.run(turn);
    });
    this.serial = task;
    this.tasks.add(task);
    void task
      .catch((error: unknown) => {
        // Without this line a failed turn leaves only `error:turn` behind.
        this.log('turn_failed', error, { turnId: turn.id });
        this.end('error:turn');
      })
      .finally(() => {
        this.tasks.delete(task);
        // Every line has played and nothing else is queued: the caller's silence starts now.
        this.idle?.arm();
      });
  }

  private async run(turn: Turn): Promise<void> {
    const abort = new AbortController();
    turn.controller = abort;
    const { id: turnId, extra } = turn;
    let cancelFiller: (() => void) | undefined;
    try {
      await this.interrupting;
      await this.receipts.deliver();
      if (this.stopped || this.closing || abort.signal.aborted) return;
      const epoch = await this.speech.beginEpoch();
      if (this.stopped || this.closing || abort.signal.aborted) return;
      this.turns.began(turn, epoch);
      this.behavior.beginTurn?.(epoch);
      const variables = { ...structuredClone(this.session.variables), ...extra };
      cancelFiller = this.filler.arm(turn, epoch);
      if (turn.speech) this.hooks.finalize({ turnId, text: turn.input, merged: turn.merged });
      const lines = new ReplyEpoch(epoch, {
        speech: this.speech,
        audibility: this.audibility,
        moved: (next, began) => {
          this.turns.moved(turn, next);
          this.receipts.alias(next, began);
        },
        say: (text, at) => this.say(text, at),
        live: () => !this.stopped,
      });
      await speakReply({
        behavior: this.behavior,
        text: turn.input,
        variables,
        signal: abort.signal,
        current: () => lines.current(),
        first: () => {
          cancelFiller?.();
          lines.first();
          // Not llm_ttfb: this interval also holds grounding, the decision and sentence
          // aggregation. The worker times each of those at its provider port.
          this.latency.stage(turnId, 'behavior_first_segment');
        },
        say: (text) => lines.say(text),
      });
      cancelFiller?.();
      await lines.settled();
      if (abort.signal.aborted) return;
      await this.receipts.deliver();
      await this.interrupting;
      if (lines.current() && this.behavior.isComplete?.()) this.complete(extra);
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    } finally {
      cancelFiller?.();
      this.turns.finish(turn);
    }
  }

  /**
   * N1: the behaviour completed. The call never ends on a caller who is talking or still owed an
   * answer: it ends once their turn turns out to be no turn at all (`endIfQuiet`, on a reset), and
   * otherwise their turn is answered, which an ending they can change does not survive.
   */
  private complete(extra: Readonly<Record<string, unknown>>): void {
    if (this.callerOpen === undefined && !this.turns.callerWaiting())
      return this.end(...completionEnd(this.behavior, extra));
    this.endDeferred = extra;
  }

  /** The caller's turn was dropped (a backchannel, noise): a deferred ending goes ahead. */
  protected endIfQuiet(): void {
    const extra = this.endDeferred;
    if (!extra || this.stopped || this.closing) return;
    if (this.callerOpen !== undefined || this.turns.callerWaiting()) return;
    this.endDeferred = undefined;
    if (this.behavior.isComplete?.()) this.end(...completionEnd(this.behavior, extra));
  }

  private say(text: string, epoch: number): void {
    const kind = this.behavior.speechKind?.(text) ?? 'response';
    this.receipts.track(this.speech.speak(text, { epoch, kind }), text);
  }

  protected log(
    event: string,
    error: unknown,
    fields: Record<string, unknown> = {},
    level: 'warn' | 'error' = 'error',
  ): void {
    logVoiceEvent(level, event, {
      sessionId: this.media.sessionId,
      ...fields,
      error: describeError(error),
    });
  }
}
