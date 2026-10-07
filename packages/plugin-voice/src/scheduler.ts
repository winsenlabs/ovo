import type {
  SessionInput,
  Speech,
  SpeechKindV2,
  SpeechReceipt,
  TextFilter,
} from '@winsendotai/ovo-contracts';
import { raceAbort } from './async.ts';
import { resolveSpeechSchedulerConfig, SpeechQueueBudget } from './budgets.ts';
import { SpeechEvidenceHistory } from './history.ts';
import { SpeechHold } from './scheduler-hold.ts';
import { SpeechSettlement, type QueueEntry } from './scheduler-settlement.ts';
import { filterSpeechText, orderTextFilters } from './speech/text-filters.ts';
import type { SpeechTimingSink } from './speech/timing.ts';
import {
  SpeechEpochError,
  SpeechSchedulerDisposedError,
  type SpeechEvidence,
  type SpeechKind,
  type SpeechOutput,
  type SpeechOutputResult,
  type SpeechSchedulerConfig,
  type SpeechSegment,
} from './types.ts';

/** What an output may also accept from the engine. */
type ConfigurableOutput = SpeechOutput & {
  configureSession?: (value: SessionInput) => void;
  configure?: (value: { markTimeoutMs?: number; maxPrefetchBytes?: number }) => void;
  configureTiming?: (sink: SpeechTimingSink) => void;
};

export class BoundedSpeechScheduler implements Speech {
  readonly history: SpeechEvidence[];
  private readonly limits: ReturnType<typeof resolveSpeechSchedulerConfig>;
  private readonly budget: SpeechQueueBudget;
  private readonly evidence: SpeechEvidenceHistory;
  private readonly settlement: SpeechSettlement;
  private readonly queue: QueueEntry[] = [];
  private readonly active = new Map<QueueEntry, AbortController>();
  private readonly tasks = new Set<Promise<void>>();
  private pumping?: Promise<void>;
  private prefetchSegments = 0;
  private filters: readonly TextFilter[] = [];
  private language = 'en-US';
  private timing?: SpeechTimingSink;
  private nextSegment = 0;
  private disposed = false;
  private _epoch = 0;
  /** P1: no line starts while the caller speaks over a reply they have not heard yet. */
  private readonly holds: SpeechHold;

  constructor(
    private readonly output: SpeechOutput,
    config: SpeechSchedulerConfig = {},
    private readonly now: () => number = Date.now,
  ) {
    this.limits = resolveSpeechSchedulerConfig(config);
    this.budget = new SpeechQueueBudget(this.limits);
    this.evidence = new SpeechEvidenceHistory(this.limits.maxEvidenceEntries, now);
    this.settlement = new SpeechSettlement(this.budget, this.evidence);
    this.history = this.evidence.entries;
    const playing = () => [...this.tasks, ...(this.pumping ? [this.pumping] : [])];
    this.holds = new SpeechHold({ queue: this.queue, active: this.active, output, playing });
  }

  get epoch(): number {
    return this._epoch;
  }

  get pendingCount(): number {
    return this.queue.length + this.active.size;
  }

  /** True between hold() and release(). */
  get held(): boolean {
    return this.holds.holding;
  }

  /** P1: no line starts until release(); see SpeechHold. */
  hold(): void {
    if (!this.holds.holding && !this.disposed) this.holds.hold(this._epoch);
  }

  release(): void {
    if (this.holds.release()) this.ensurePump();
  }

  /** Resolves once no line is playing; held lines, waiting to start, do not count. */
  settled(): Promise<void> {
    return this.holds.settled();
  }

  /** The native engine enables bounded overlap; legacy callers keep serial playback. */
  configurePipeline(prefetchSegments: number): void {
    if (!Number.isInteger(prefetchSegments) || prefetchSegments < 0 || prefetchSegments > 4)
      throw new RangeError('prefetchSegments must be between 0 and 4');
    // Outputs without prepare have no overlap contract. In particular, a host
    // cache override may own only one carrier writer per epoch.
    this.prefetchSegments = this.output.prepare ? prefetchSegments : 0;
  }

  configureSession(session: SessionInput): void {
    (this.output as ConfigurableOutput).configureSession?.(session);
  }

  configureOutput(options: { markTimeoutMs?: number; maxPrefetchBytes?: number }): void {
    (this.output as ConfigurableOutput).configure?.(options);
  }

  configureTiming(listener: SpeechTimingSink): void {
    this.timing = listener;
    (this.output as ConfigurableOutput).configureTiming?.(listener);
  }

  configureFilters(filters: readonly TextFilter[], language: string): void {
    this.filters = orderTextFilters(filters);
    this.language = language;
  }

  subscribe(listener: (evidence: SpeechEvidence) => void): () => void {
    return this.evidence.subscribe(listener);
  }

  speak(
    text: string,
    options: { epoch?: number; kind?: SpeechKindV2 } = {},
  ): Promise<SpeechReceipt> {
    if (this.disposed) return Promise.reject(new SpeechSchedulerDisposedError());
    const requestedAt = this.now();
    text = filterSpeechText(this.filters, text, this.language);
    if (!text.trim()) return Promise.reject(new TypeError('Speech text must not be empty'));

    const epoch = options.epoch ?? this._epoch;
    if (epoch !== this._epoch) return Promise.reject(new SpeechEpochError(epoch, this._epoch));
    const segment: SpeechSegment = Object.freeze({
      id: `speech-${++this.nextSegment}`,
      text,
      epoch,
      kind: (options.kind ?? 'response') as SpeechKind,
      generatedAt: this.now(),
    });
    this.timing?.('text-ready', segment, Math.max(0, segment.generatedAt - requestedAt));
    this.evidence.record(segment, 'generated', 'generated');

    const overflow = this.budget.overflow(this.pendingCount, text);
    if (overflow) {
      this.evidence.record(segment, 'dropped', 'generated', overflow.message);
      return Promise.reject(overflow);
    }

    const order = this.nextSegment;
    const promise = new Promise<SpeechReceipt>((resolve, reject) => {
      this.queue.push({
        segment,
        resolve,
        reject,
        settled: false,
        controller: new AbortController(),
        order,
      });
      this.budget.add(text);
      this.evidence.record(segment, 'queued', 'generated');
    });
    this.ensurePump();
    return promise;
  }

  /** Starts a new response epoch and flushes every segment from the old epoch. */
  async beginEpoch(): Promise<number> {
    const oldEpoch = this._epoch;
    this._epoch += 1;
    await this.cancelEpoch(oldEpoch, 'superseded by a newer response epoch');
    return this._epoch;
  }

  async cancelEpoch(epoch: number, reason = 'epoch cancelled'): Promise<void> {
    const active = [...this.active].filter(([entry]) => entry.segment.epoch === epoch);
    for (const [, controller] of active) controller.abort(new DOMException(reason, 'AbortError'));
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const entry = this.queue[index];
      if (entry.segment.epoch !== epoch) continue;
      this.queue.splice(index, 1);
      entry.controller.abort(new DOMException(reason, 'AbortError'));
      this.settlement.interrupted(entry, reason);
    }
    // Initial announcements must not clear before media acceptance.
    if (active.length) await this.output.interrupt(epoch);
  }

  async interrupt(): Promise<void> {
    await this.beginEpoch();
  }

  async idle(): Promise<void> {
    while (this.pumping) await this.pumping;
    while (this.tasks.size) await Promise.all([...this.tasks]);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const epoch = this._epoch;
    this._epoch += 1;
    await this.cancelEpoch(epoch, 'scheduler disposed');
    await this.pumping;
    await Promise.all([...this.tasks]);
    this.evidence.clearListeners();
  }

  private async pump(): Promise<void> {
    while (!this.disposed && this.queue.length > 0) {
      if (this.waitsHeld()) break;
      const entry = this.queue.shift()!;
      if (entry.segment.epoch !== this._epoch) {
        this.settlement.interrupted(entry, 'stale response epoch');
        continue;
      }
      if (this.prefetchSegments === 0) {
        await this.play(entry);
        continue;
      }
      const task = this.play(entry).finally(() => this.tasks.delete(task));
      this.tasks.add(task);
      if (this.tasks.size >= this.prefetchSegments + 1) await Promise.race([...this.tasks]);
    }
  }

  private async play(entry: QueueEntry): Promise<void> {
    const controller = entry.controller;
    this.active.set(entry, controller);
    this.evidence.record(entry.segment, 'started', 'generated');
    const timeout = setTimeout(() => {
      controller.abort(new DOMException('speech playback timed out', 'TimeoutError'));
    }, this.limits.playbackTimeoutMs);
    timeout.unref?.();

    try {
      // Raced, so a line taken back for the caller (P1) leaves even a prepare that ignores aborts.
      const preparing = this.output.prepare?.(entry.segment, controller.signal);
      if (preparing) await raceAbort(preparing, controller.signal);
      const result = await raceAbort(
        this.output.play(entry.segment, {
          signal: controller.signal,
          report: (phase, evidence) => {
            if (this.holds.reported(entry, phase))
              this.evidence.record(entry.segment, phase, evidence);
          },
        }),
        controller.signal,
      );
      if (entry.held) return this.requeue(entry);
      const current = entry.segment.epoch === this._epoch && !controller.signal.aborted;
      this.settlement.finished(entry, result, current);
    } catch (error) {
      if (entry.held) return this.requeue(entry);
      await this.settlement.failed(entry, controller.signal, error, (epoch) =>
        this.output.interrupt(epoch),
      );
    } finally {
      clearTimeout(timeout);
      if (this.active.get(entry) === controller) this.active.delete(entry);
    }
  }

  /** A held line has left the output: it waits in the queue again, unless its epoch ended. */
  private requeue(entry: QueueEntry): void {
    if (!this.holds.returned(entry, !this.disposed && entry.segment.epoch === this._epoch))
      this.settlement.interrupted(entry, 'stale response epoch');
    this.ensurePump();
  }

  private waitsHeld(): boolean {
    return this.holds.next(this._epoch, this.prefetchSegments + 1);
  }

  private ensurePump(): void {
    if (this.pumping || this.disposed || this.queue.length === 0 || this.waitsHeld()) return;
    this.pumping = this.pump().finally(() => {
      this.pumping = undefined;
      this.ensurePump();
    });
  }
}
