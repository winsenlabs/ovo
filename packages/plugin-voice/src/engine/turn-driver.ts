import type {
  Behavior,
  MediaDuplex,
  SessionInput,
  SpeechReceipt,
  TurnDecision,
} from '@winsendotai/ovo-contracts';
import { raceAbort } from '../async.ts';
import { BoundedSpeechScheduler } from '../scheduler.ts';
import { VoiceEventBus } from './events.ts';
import { TurnLatency } from './latency.ts';

/** Coordinates behavior, speech epochs, and receipts across initial, STT and DTMF turns. */
export class TurnDriver {
  private readonly receipts = new Set<Promise<void>>();
  private readonly tasks = new Set<Promise<void>>();
  private interrupting: Promise<void> = Promise.resolve();
  private serial: Promise<void> = Promise.resolve();
  private stopped = false;
  private nextTurn = 0;
  private activeTurn?: AbortController;
  private readonly epochTurns = new Map<number, string>();

  turnIdForEpoch(epoch: number): string | undefined {
    return this.epochTurns.get(epoch);
  }

  constructor(
    private readonly behavior: Behavior,
    private readonly speech: BoundedSpeechScheduler,
    private readonly session: SessionInput,
    private readonly events: VoiceEventBus,
    private readonly latency: TurnLatency,
    private readonly end: (reason: 'behavior_completed' | 'caller_idle' | 'error:turn') => void,
    private readonly maxConcurrentTurns: number,
    private readonly media: MediaDuplex,
  ) {}

  decide(decision: TurnDecision): void {
    if (this.stopped) return;
    if (decision.type === 'force-endpoint') return;
    if (decision.type === 'interrupt') {
      this.events.emit({ type: 'interrupt', reason: decision.reason });
      this.activeTurn?.abort(new DOMException('turn interrupted', 'AbortError'));
      this.behavior.cancel?.();
      const turnId = this.epochTurns.get(this.speech.epoch) ?? 'interruption';
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
      const variables = input.kind === 'dtmf' ? { inputEvent: 'dtmf', digits: input.digits } : {};
      this.events.emit({
        type: 'user.turn',
        phase: 'stopped',
        turnId: decision.turnId,
        input: input.kind,
        text: input.kind === 'speech' ? input.text : input.digits,
      });
      this.queue(input.kind === 'speech' ? input.text : input.digits, variables, decision.turnId);
    }
    if (decision.type === 'idle') {
      this.events.emit({ type: 'user.turn', phase: 'idle', turnId: 'idle-' + decision.retry });
      if (decision.final) this.end('caller_idle');
      else if (decision.prompt)
        this.track(this.speech.speak(decision.prompt, { kind: 'idle-prompt' }));
    }
  }

  initial(input: string): void {
    this.queue(input, {}, 'initial-' + ++this.nextTurn);
  }

  async dispose(): Promise<void> {
    this.stopped = true;
    this.activeTurn?.abort(new DOMException('engine disposed', 'AbortError'));
    this.behavior.cancel?.();
    await Promise.allSettled([...this.tasks, ...this.receipts]);
  }

  private queue(input: string, extra: Record<string, unknown>, turnId: string): void {
    if (this.tasks.size >= this.maxConcurrentTurns) {
      this.end('error:turn');
      return;
    }
    const task = this.serial.catch(() => undefined).then(() => this.run(input, extra, turnId));
    this.serial = task;
    this.tasks.add(task);
    void task.catch(() => this.end('error:turn')).finally(() => this.tasks.delete(task));
  }

  private async run(input: string, extra: Record<string, unknown>, turnId: string): Promise<void> {
    const turn = new AbortController();
    this.activeTurn = turn;
    let epoch: number | undefined;
    let iterator: AsyncIterator<string> | undefined;
    try {
      await this.interrupting;
      await this.deliverReceipts();
      if (this.stopped || turn.signal.aborted) return;
      epoch = await this.speech.beginEpoch();
      if (this.stopped || turn.signal.aborted) return;
      this.epochTurns.set(epoch, turnId);
      this.behavior.beginTurn?.(epoch);
      this.latency.start(turnId);
      this.latency.stage(turnId, 'turn_decision');
      const variables = { ...structuredClone(this.session.variables), ...extra };
      if (this.behavior.respondStream) {
        iterator = this.behavior.respondStream(input, variables)[Symbol.asyncIterator]();
        let first = true;
        while (!turn.signal.aborted) {
          const next = await raceAbort(iterator.next(), turn.signal);
          if (next.done || this.stopped || epoch !== this.speech.epoch) break;
          const text = next.value;
          if (!text.trim()) continue;
          if (first) {
            first = false;
            // Not llm_ttfb: this interval also holds grounding, the decision and sentence
            // aggregation. The worker times each of those at its provider port.
            this.latency.stage(turnId, 'behavior_first_segment');
          }
          this.track(
            this.speech.speak(text, {
              epoch,
              kind: this.behavior.speechKind?.(text) ?? 'response',
            }),
          );
        }
      } else {
        const text = await raceAbort(this.behavior.respond(input, variables), turn.signal);
        if (!this.stopped && epoch === this.speech.epoch && text.trim()) {
          this.latency.stage(turnId, 'behavior_first_segment');
          this.track(
            this.speech.speak(text, {
              epoch,
              kind: this.behavior.speechKind?.(text) ?? 'response',
            }),
          );
        }
      }
      if (turn.signal.aborted) return;
      await this.deliverReceipts();
      await this.interrupting;
      if (!this.stopped && epoch === this.speech.epoch && this.behavior.isComplete?.())
        this.end('behavior_completed');
    } catch (error) {
      if (!turn.signal.aborted) throw error;
    } finally {
      void Promise.resolve()
        .then(() => iterator?.return?.())
        .catch(() => undefined);
      if (epoch !== undefined) {
        this.latency.total(turnId);
        this.latency.clear(turnId);
        this.epochTurns.delete(epoch);
      }
      if (this.activeTurn === turn) this.activeTurn = undefined;
    }
  }

  private track(receipt: Promise<SpeechReceipt>): void {
    let delivery!: Promise<void>;
    delivery = receipt
      .then((value) =>
        this.behavior.onPlayback?.(
          value.evidence === 'confirmed' &&
            this.media.playbackEvidence === 'carrier-processed' &&
            this.session.acknowledgements.includes('weak-playback-evidence')
            ? { ...value, evidenceSource: 'carrier-processed' }
            : value,
        ),
      )
      .then(() => undefined)
      .catch(() => {
        // Receipt failures can arrive while respondStream is still awaiting its
        // next item. Observe them immediately, before removing the pending entry.
        this.stopped = true;
        this.activeTurn?.abort(new DOMException('speech receipt failed', 'AbortError'));
        this.end('error:turn');
      })
      .finally(() => this.receipts.delete(delivery));
    this.receipts.add(delivery);
  }

  private async deliverReceipts(): Promise<void> {
    while (this.receipts.size) await Promise.all([...this.receipts]);
  }
}
