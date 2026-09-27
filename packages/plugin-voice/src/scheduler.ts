import type {
  SessionInput,
  Speech,
  SpeechKindV2,
  SpeechReceipt,
  TextFilter,
} from '@winsendotai/ovo-contracts';
import { errorMessage, isAbortError, raceAbort } from './async.ts';
import { resolveSpeechSchedulerConfig, SpeechQueueBudget } from './budgets.ts';
import { SpeechEvidenceHistory } from './history.ts';
import { SpeechSettlement, type QueueEntry } from './scheduler-settlement.ts';
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
  }

  get epoch(): number {
    return this._epoch;
  }

  get pendingCount(): number {
    return this.queue.length + this.active.size;
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
    (
      this.output as SpeechOutput & { configureSession?: (value: SessionInput) => void }
    ).configureSession?.(session);
  }

  configureOutput(options: { markTimeoutMs?: number; maxPrefetchBytes?: number }): void {
    (
      this.output as SpeechOutput & {
        configure?: (value: typeof options) => void;
      }
    ).configure?.(options);
  }

  configureTiming(listener: SpeechTimingSink): void {
    this.timing = listener;
    (
      this.output as SpeechOutput & {
        configureTiming?: (sink: SpeechTimingSink) => void;
      }
    ).configureTiming?.(listener);
  }

  configureFilters(filters: readonly TextFilter[], language: string): void {
    this.filters = [...filters].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
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
    for (const filter of this.filters) text = filter.apply(text, { language: this.language });
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

    const promise = new Promise<SpeechReceipt>((resolve, reject) => {
      this.queue.push({
        segment,
        resolve,
        reject,
        settled: false,
        controller: new AbortController(),
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
      await this.output.prepare?.(entry.segment, controller.signal);
      const result = await raceAbort(
        this.output.play(entry.segment, {
          signal: controller.signal,
          report: (phase, evidence) => this.evidence.record(entry.segment, phase, evidence),
        }),
        controller.signal,
      );
      if (
        entry.segment.epoch !== this._epoch ||
        controller.signal.aborted ||
        result.state === 'interrupted'
      ) {
        this.settlement.interrupted(entry, 'playback interrupted', result.evidence);
      } else {
        this.settlement.played(entry, result);
      }
    } catch (error) {
      await this.handlePlaybackError(entry, controller, error);
    } finally {
      clearTimeout(timeout);
      this.active.delete(entry);
    }
  }

  private async handlePlaybackError(
    entry: QueueEntry,
    controller: AbortController,
    error: unknown,
  ): Promise<void> {
    if (!controller.signal.aborted && !isAbortError(error)) {
      this.evidence.record(entry.segment, 'failed', 'generated', errorMessage(error));
      this.settlement.reject(entry, error);
      return;
    }
    if (
      controller.signal.reason instanceof DOMException &&
      controller.signal.reason.name === 'TimeoutError'
    ) {
      try {
        await this.output.interrupt(entry.segment.epoch);
      } catch (interruptError) {
        this.evidence.record(
          entry.segment,
          'failed',
          'generated',
          `playback timeout flush failed: ${errorMessage(interruptError)}`,
        );
      }
    }
    this.settlement.interrupted(
      entry,
      errorMessage(controller.signal.reason ?? 'speech playback aborted'),
    );
  }

  private ensurePump(): void {
    if (this.pumping || this.disposed || this.queue.length === 0) return;
    this.pumping = this.pump().finally(() => {
      this.pumping = undefined;
      this.ensurePump();
    });
  }
}
