import type {
  Behavior,
  Clock,
  MediaDuplex,
  SessionInput,
  TurnDecision,
  TurnSpeculation,
} from '@winsendotai/ovo-contracts';
import { BoundedSpeechScheduler } from '../scheduler.ts';
import type { AnsweredBy } from './answered-by-gate.ts';
import { realClock } from './clock.ts';
import { VoiceEventBus } from './events.ts';
import { IdleWatch } from './idle-watch.ts';
import { SpeechReceipts } from './speech-receipts.ts';
import { TurnLatency } from './latency.ts';
import { describeError, logVoiceEvent } from './log.ts';
import { ReplyAudibility } from './turn-audibility.ts';
import { callerTurn, engineTurn, TurnBook, type Turn } from './turn-book.ts';
import { TurnFiller } from './turn-filler.ts';
import { speakReply } from './turn-reply.ts';
import { SpeculationHooks } from './turn-speculation.ts';
import { leaveVoicemail } from './turn-voicemail.ts';

export type DriverEndReason = 'behavior_completed' | 'caller_idle' | 'voicemail' | 'error:turn';

/** Coordinates behavior, speech epochs, and receipts across initial, STT and DTMF turns. */
export class TurnDriver {
  private readonly receipts: SpeechReceipts;
  private readonly tasks = new Set<Promise<void>>();
  private interrupting: Promise<unknown> = Promise.resolve();
  private serial: Promise<void> = Promise.resolve();
  private stopped = false;
  /** Set once the call is being ended for an answering machine; no new turn starts. */
  private closing = false;
  private nextTurn = 0;
  private readonly turns: TurnBook;
  private readonly filler: TurnFiller;
  /** Set when the behaviour handles silence; the turn detector's idle prompts are then ignored. */
  private readonly idle?: IdleWatch;
  private readonly audibility = new ReplyAudibility();
  private readonly hooks: SpeculationHooks;
  private readonly unsubscribe: () => void;

  turnIdForEpoch = (epoch: number): string | undefined => this.turns.idForEpoch(epoch);

  constructor(
    private readonly behavior: Behavior & TurnSpeculation,
    private readonly speech: BoundedSpeechScheduler,
    private readonly session: SessionInput,
    private readonly events: VoiceEventBus,
    private readonly latency: TurnLatency,
    private readonly end: (reason: DriverEndReason, detail?: string) => void,
    private readonly maxConcurrentTurns: number,
    private readonly media: MediaDuplex,
    clock: Pick<Clock, 'setTimeout'> = realClock,
  ) {
    this.receipts = new SpeechReceipts(behavior, media, session, (error) => {
      this.log('speech_receipt_failed', error);
      this.stopped = true;
      this.turns.abortRunning('speech receipt failed');
      this.end('error:turn');
    });
    this.idle = IdleWatch.for(behavior, clock, events, {
      quiet: () => !this.stopped && !this.closing && !this.tasks.size,
      run: (turnId) => this.queue(engineTurn(turnId, '', { inputEvent: 'idle' })),
    });
    this.hooks = new SpeculationHooks(behavior, (hook, error) =>
      this.log('speculation_hook_failed', error, { hook }, 'warn'),
    );
    this.unsubscribe = speech.subscribe((evidence) => this.audibility.observe(evidence));
    this.turns = new TurnBook(this.audibility, this.hooks, latency);
    this.filler = new TurnFiller(
      clock,
      speech,
      this.audibility,
      () => !this.stopped && !this.closing,
      (turnId, error) => this.log('filler_failed', error, { turnId }, 'warn'),
    );
  }

  decide(decision: TurnDecision): void {
    if (this.stopped || this.closing) return;
    if (decision.type === 'force-endpoint') return;
    if (decision.type === 'turn.partial') return this.hooks.prepare(decision);
    // The caller is taking a turn, or a false start ended with nothing to answer.
    if (decision.type === 'turn.reset') {
      this.idle?.arm();
      const carry = this.turns.reset(decision.turnId);
      if (carry) this.queue(carry);
    } else if (decision.type !== 'idle') this.idle?.cancel();
    if (decision.type === 'interrupt') {
      this.events.emit({ type: 'interrupt', reason: decision.reason });
      this.turns.interrupted();
      this.turns.abortRunning('turn interrupted');
      this.behavior.cancel?.();
      const turnId = this.turns.idForEpoch(this.speech.epoch) ?? 'interruption';
      this.latency.start(turnId);
      this.interrupting = this.speech.beginEpoch().then(() => {
        this.latency.stage(turnId, 'bargein_latency');
      });
      return;
    }
    if (decision.type === 'turn.started')
      this.events.emit({ type: 'user.turn', phase: 'started', turnId: decision.turnId });
    if (decision.type === 'turn.stopped') {
      const input = decision.input;
      this.latency.accept(decision.turnId, input.kind === 'speech');
      this.events.emit({
        type: 'user.turn',
        phase: 'stopped',
        turnId: decision.turnId,
        input: input.kind,
        text: input.kind === 'speech' ? input.text : input.digits,
      });
      if (input.kind === 'speech') this.caller(decision.turnId, input.text, decision.filler);
      else {
        this.turns.takeCarry();
        const extra = { inputEvent: 'dtmf', digits: input.digits };
        this.queue(engineTurn(decision.turnId, input.digits, extra));
      }
    }
    if (decision.type === 'idle' && !this.idle) {
      this.events.emit({ type: 'user.turn', phase: 'idle', turnId: 'idle-' + decision.retry });
      if (decision.final) this.end('caller_idle');
      else if (decision.prompt)
        this.receipts.track(this.speech.speak(decision.prompt, { kind: 'idle-prompt' }));
    }
  }

  initial(input: string): void {
    this.queue(engineTurn('initial-' + ++this.nextTurn, input, {}));
  }

  /** The speak-first opening turn: `respond('', { inputEvent: 'opening' })`, before any caller turn. */
  opening(answeredBy?: AnsweredBy): void {
    const extra = { inputEvent: 'opening', ...(answeredBy ? { answeredBy } : {}) };
    this.queue(engineTurn('opening-' + ++this.nextTurn, '', extra));
  }

  /** An answering machine picked up (see `leaveVoicemail`); false when the behaviour ignores it. */
  voicemail(): boolean {
    if (this.stopped || this.closing) return false;
    const task = leaveVoicemail({
      behavior: this.behavior,
      session: this.session,
      speech: this.speech,
      cutOff: () => {
        this.closing = true;
        this.turns.abortRunning('answering machine');
        this.behavior.cancel?.();
      },
      settled: () => this.interrupting,
      stopped: () => this.stopped,
      end: (detail) => this.end('voicemail', detail),
      failed: (error) => this.log('voicemail_message_failed', error),
    });
    if (!task) return false;
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task));
    return true;
  }

  async dispose(): Promise<void> {
    this.stopped = true;
    this.idle?.dispose();
    this.unsubscribe();
    this.turns.abortRunning('engine disposed');
    this.behavior.cancel?.();
    await Promise.allSettled([...this.tasks, ...this.receipts.inFlight()]);
  }

  /**
   * AGT-10: the caller spoke again before hearing any answer to their last words. The reply still
   * waiting or being composed for them is abandoned (its decision, LLM and TTS work cancelled, its
   * speech never played) and one reply answers both, newest words last.
   */
  private caller(id: string, text: string, filler: Turn['filler']): void {
    const { queue, supersede } = this.turns.caller(callerTurn(id, text, filler));
    if (supersede) {
      supersede.controller?.abort(new DOMException('turn superseded', 'AbortError'));
      this.behavior.cancel?.();
      // Flushes the stale reply's queued lines and its synthesis before any audio reaches the caller.
      if (supersede.epoch !== undefined) this.interrupting = this.speech.beginEpoch();
    }
    if (queue) this.queue(queue);
  }

  private queue(turn: Turn): void {
    if (this.tasks.size >= this.maxConcurrentTurns) {
      this.end('error:turn');
      return;
    }
    this.turns.enqueue(turn);
    // swallow-ok: the earlier turn's own task.catch below ends the call; this only orders turns.
    const previous = this.serial.catch(() => undefined);
    const task = previous.then(() => {
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
    let epoch: number | undefined;
    let cancelFiller: (() => void) | undefined;
    try {
      await this.interrupting;
      await this.receipts.deliver();
      if (this.stopped || this.closing || abort.signal.aborted) return;
      epoch = await this.speech.beginEpoch();
      if (this.stopped || this.closing || abort.signal.aborted) return;
      this.turns.began(turn, epoch);
      this.behavior.beginTurn?.(epoch);
      const variables = { ...structuredClone(this.session.variables), ...extra };
      cancelFiller = this.filler.arm(turn, epoch);
      if (turn.speech) this.hooks.finalize({ turnId, text: turn.input, merged: turn.merged });
      await speakReply({
        behavior: this.behavior,
        text: turn.input,
        variables,
        signal: abort.signal,
        current: () => !this.stopped && epoch === this.speech.epoch,
        first: () => {
          cancelFiller?.();
          // Not llm_ttfb: this interval also holds grounding, the decision and sentence
          // aggregation. The worker times each of those at its provider port.
          this.latency.stage(turnId, 'behavior_first_segment');
        },
        say: (text) => this.say(text, epoch!),
      });
      cancelFiller?.();
      if (abort.signal.aborted) return;
      await this.receipts.deliver();
      await this.interrupting;
      if (!this.stopped && epoch === this.speech.epoch && this.behavior.isComplete?.())
        this.end(
          extra.inputEvent === 'idle' ? 'caller_idle' : 'behavior_completed',
          this.behavior.completionReason?.(),
        );
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    } finally {
      cancelFiller?.();
      this.turns.finish(turn);
    }
  }

  private say(text: string, epoch: number): void {
    const kind = this.behavior.speechKind?.(text) ?? 'response';
    this.receipts.track(this.speech.speak(text, { epoch, kind }), text);
  }

  private log(
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
