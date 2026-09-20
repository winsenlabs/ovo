import type { Speech, SpeechReceipt } from '@winsendotai/ovo-contracts';
import { errorMessage, isAbortError, raceAbort } from './async.ts';
import { resolveSpeechSchedulerConfig, SpeechQueueBudget } from './budgets.ts';
import { SpeechEvidenceHistory } from './history.ts';
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

interface QueueEntry {
  segment: SpeechSegment;
  resolve: (receipt: SpeechReceipt) => void;
  reject: (error: unknown) => void;
  settled: boolean;
}

export class BoundedSpeechScheduler implements Speech {
  readonly history: SpeechEvidence[];
  private readonly limits: ReturnType<typeof resolveSpeechSchedulerConfig>;
  private readonly budget: SpeechQueueBudget;
  private readonly evidence: SpeechEvidenceHistory;
  private readonly queue: QueueEntry[] = [];
  private current?: { entry: QueueEntry; controller: AbortController };
  private pumping?: Promise<void>;
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
    this.history = this.evidence.entries;
  }

  get epoch(): number {
    return this._epoch;
  }

  get pendingCount(): number {
    return this.queue.length + (this.current ? 1 : 0);
  }

  subscribe(listener: (evidence: SpeechEvidence) => void): () => void {
    return this.evidence.subscribe(listener);
  }

  speak(text: string, options: { epoch?: number; kind?: SpeechKind } = {}): Promise<SpeechReceipt> {
    if (this.disposed) return Promise.reject(new SpeechSchedulerDisposedError());
    if (!text.trim()) return Promise.reject(new TypeError('Speech text must not be empty'));

    const epoch = options.epoch ?? this._epoch;
    if (epoch !== this._epoch) return Promise.reject(new SpeechEpochError(epoch, this._epoch));
    const segment: SpeechSegment = Object.freeze({
      id: `speech-${++this.nextSegment}`,
      text,
      epoch,
      kind: options.kind ?? 'response',
      generatedAt: this.now(),
    });
    this.evidence.record(segment, 'generated', 'generated');

    const overflow = this.budget.overflow(this.pendingCount, text);
    if (overflow) {
      this.evidence.record(segment, 'dropped', 'generated', overflow.message);
      return Promise.reject(overflow);
    }

    const promise = new Promise<SpeechReceipt>((resolve, reject) => {
      this.queue.push({ segment, resolve, reject, settled: false });
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
    if (this.current?.entry.segment.epoch === epoch) {
      this.current.controller.abort(new DOMException(reason, 'AbortError'));
    }
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const entry = this.queue[index];
      if (entry.segment.epoch !== epoch) continue;
      this.queue.splice(index, 1);
      this.completeInterrupted(entry, reason);
    }
    await this.output.interrupt(epoch);
  }

  async interrupt(): Promise<void> {
    await this.beginEpoch();
  }

  async idle(): Promise<void> {
    while (this.pumping) await this.pumping;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const epoch = this._epoch;
    this._epoch += 1;
    await this.cancelEpoch(epoch, 'scheduler disposed');
    await this.pumping;
    this.evidence.clearListeners();
  }

  private async pump(): Promise<void> {
    while (!this.disposed && this.queue.length > 0) {
      const entry = this.queue.shift()!;
      if (entry.segment.epoch !== this._epoch) {
        this.completeInterrupted(entry, 'stale response epoch');
        continue;
      }
      await this.play(entry);
    }
  }

  private async play(entry: QueueEntry): Promise<void> {
    const controller = new AbortController();
    this.current = { entry, controller };
    this.evidence.record(entry.segment, 'started', 'generated');
    const timeout = setTimeout(() => {
      controller.abort(new DOMException('speech playback timed out', 'TimeoutError'));
    }, this.limits.playbackTimeoutMs);
    timeout.unref?.();

    try {
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
        this.completeInterrupted(entry, 'playback interrupted', result.evidence);
      } else {
        this.completePlayed(entry, result);
      }
    } catch (error) {
      await this.handlePlaybackError(entry, controller, error);
    } finally {
      clearTimeout(timeout);
      if (this.current?.entry === entry) this.current = undefined;
    }
  }

  private completePlayed(entry: QueueEntry, result: SpeechOutputResult): void {
    this.settle(entry, {
      id: entry.segment.id,
      text: entry.segment.text,
      epoch: entry.segment.epoch,
      state: 'completed',
      evidence: result.evidence,
    });
    this.evidence.record(entry.segment, 'completed', result.evidence);
  }

  private async handlePlaybackError(
    entry: QueueEntry,
    controller: AbortController,
    error: unknown,
  ): Promise<void> {
    if (!controller.signal.aborted && !isAbortError(error)) {
      this.evidence.record(entry.segment, 'failed', 'generated', errorMessage(error));
      this.reject(entry, error);
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
    this.completeInterrupted(entry, abortReason(controller.signal));
  }

  private ensurePump(): void {
    if (this.pumping || this.disposed || this.queue.length === 0) return;
    this.pumping = this.pump().finally(() => {
      this.pumping = undefined;
      this.ensurePump();
    });
  }

  private completeInterrupted(
    entry: QueueEntry,
    reason: string,
    evidence: SpeechOutputResult['evidence'] = 'estimated',
  ): void {
    if (entry.settled) return;
    this.settle(entry, {
      id: entry.segment.id,
      text: entry.segment.text,
      epoch: entry.segment.epoch,
      state: 'interrupted',
      evidence,
    });
    this.evidence.record(entry.segment, 'interrupted', evidence, reason);
  }

  private settle(entry: QueueEntry, receipt: SpeechReceipt): void {
    if (entry.settled) return;
    entry.settled = true;
    this.budget.remove(entry.segment.text);
    entry.resolve(receipt);
  }

  private reject(entry: QueueEntry, error: unknown): void {
    if (entry.settled) return;
    entry.settled = true;
    this.budget.remove(entry.segment.text);
    entry.reject(error);
  }
}

function abortReason(signal: AbortSignal): string {
  return errorMessage(signal.reason ?? 'speech playback aborted');
}
