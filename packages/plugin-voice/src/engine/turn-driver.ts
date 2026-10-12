import type { TurnDecision } from '@winsendotai/ovo-contracts';
import type { AnsweredBy } from './answered-by-gate.ts';
import { DetectorIdle } from './idle-pacing.ts';
import { callerTurn, engineTurn } from './turn-book.ts';
import { TurnRunner } from './turn-runner.ts';
import { leaveVoicemail } from './turn-voicemail.ts';
import { closeCall, scheduleWrapUp, type WrapUpConfig } from './turn-wrap-up.ts';

export type { DriverEndReason } from './turn-completion.ts';

/**
 * Turns the detector's decisions into the replies the call owes (run by TurnRunner), and opens and
 * closes the call: the greeting, an answering machine, and the wrap-up at the time limit.
 */
export class TurnDriver extends TurnRunner {
  private nextTurn = 0;
  private cancelWrapUp?: () => void;
  /** The turn detector's idle prompts, paced by the last answer (call-3 #8). */
  private readonly detectorIdle = new DetectorIdle(
    this.clock,
    this.events,
    this.pacing,
    () =>
      !this.stopped &&
      !this.closing &&
      this.callerOpen === undefined &&
      !this.tasks.size &&
      !this.speech.pendingCount,
    (decision) => this.idlePrompt(decision),
  );
  /** Wave 8b: a reply given up for the words of a turn the reply hold gave up on runs now. */
  private readonly unlapse = this.hold.onLapse(() => {
    const carry = this.turns.lapsed();
    if (carry && !this.stopped && !this.closing) this.queue(carry);
  });

  decide(decision: TurnDecision): void {
    if (this.stopped || this.closing) return;
    if (decision.type === 'force-endpoint') return;
    if (decision.type === 'turn.partial') {
      this.hold.partial(decision.turnId);
      // Wave 8b: words that will supersede the reply running stop its work now (TurnBook.preempt).
      const preempted = this.turns.preempt(decision.text);
      if (preempted) this.abandon(preempted);
      return this.hooks.prepare(decision);
    }
    // The caller is taking a turn, or a false start ended with nothing to answer.
    if (decision.type === 'turn.reset') {
      if (this.callerOpen === decision.turnId) this.callerOpen = undefined;
      this.hold.ended(decision.turnId, 'reset');
      this.idle?.arm();
      const carry = this.turns.reset(decision.turnId);
      if (carry) this.queue(carry);
      this.endIfQuiet();
    } else if (decision.type !== 'idle') {
      this.idle?.cancel();
      this.detectorIdle.cancel();
    }
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
    if (decision.type === 'turn.started') {
      this.callerOpen = decision.turnId;
      this.events.emit({ type: 'user.turn', phase: 'started', turnId: decision.turnId });
      this.hold.started(decision.turnId);
    }
    if (decision.type === 'turn.stopped') {
      if (this.callerOpen === decision.turnId) this.callerOpen = undefined;
      const input = decision.input;
      const endpointMs = this.latency.accept(decision.turnId, input.kind === 'speech');
      this.events.emit({
        type: 'user.turn',
        phase: 'stopped',
        turnId: decision.turnId,
        input: input.kind,
        text: input.kind === 'speech' ? input.text : input.digits,
        ...(endpointMs === undefined ? {} : { endpointMs }),
        ...(decision.reason ? { endpointRule: decision.reason } : {}),
      });
      this.detectorIdle.answered();
      if (input.kind === 'speech')
        this.caller(callerTurn(decision.turnId, input.text, decision.filler, decision.untrusted));
      else {
        this.turns.takeCarry();
        const extra = { inputEvent: 'dtmf', digits: input.digits };
        this.queue(engineTurn(decision.turnId, input.digits, extra));
      }
      // AGT-10 superseded the held reply or queued these words behind it: it plays now.
      this.hold.ended(decision.turnId, 'stopped');
      // Wave 8b: unless these words trailed off, when the caller may yet go on.
      if (input.kind === 'speech' && decision.reason === 'hold') this.hold.trailedOff();
    }
    if (decision.type === 'idle' && !this.idle) this.detectorIdle.idle(decision);
  }

  private idlePrompt(decision: Extract<TurnDecision, { type: 'idle' }>): void {
    this.events.emit({ type: 'user.turn', phase: 'idle', turnId: 'idle-' + decision.retry });
    if (decision.final) this.end('caller_idle');
    else if (decision.prompt)
      this.receipts.track(this.speech.speak(decision.prompt, { kind: 'idle-prompt' }));
  }

  initial(input: string): void {
    this.queue(engineTurn('initial-' + ++this.nextTurn, input, {}));
  }

  /** Arms the wrap-up before the call time limit, from the call's start (see `scheduleWrapUp`). */
  armWrapUp(config?: WrapUpConfig): void {
    const { clock, session } = this;
    const run = (line: string, finishMs: number) => this.wrapUp(line, finishMs);
    this.cancelWrapUp = scheduleWrapUp(clock, session.maxCallSeconds, config, run);
  }

  override async dispose(): Promise<void> {
    this.cancelWrapUp?.();
    this.unlapse();
    this.detectorIdle.dispose();
    await super.dispose();
  }

  /** Graceful max-duration wrap-up (see `closeCall`): ends completed, detail `max_duration`. */
  wrapUp(line: string, finishMs: number): void {
    if (this.stopped || this.closing) return;
    this.cutOff('call time limit');
    const live = () => !this.stopped;
    const { speech, clock } = this;
    const settled = () => this.interrupting;
    this.track(
      closeCall({ speech, clock, line, finishMs, live, settled })
        .catch((error: unknown) => this.log('wrap_up_failed', error, {}, 'warn'))
        .finally(() => live() && this.end('behavior_completed', 'max_duration')),
    );
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
      cutOff: () => this.cutOff('answering machine'),
      settled: () => this.interrupting,
      stopped: () => this.stopped,
      end: (detail) => this.end('voicemail', detail),
      failed: (error) => this.log('voicemail_message_failed', error),
    });
    if (!task) return false;
    this.track(task);
    return true;
  }
}
