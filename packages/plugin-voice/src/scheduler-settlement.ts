import type { SpeechReceipt } from '@winsendotai/ovo-contracts';
import { errorMessage, isAbortError } from './async.ts';
import type { SpeechQueueBudget } from './budgets.ts';
import type { SpeechEvidenceHistory } from './history.ts';
import type { SpeechPlayout } from './scheduler-playout.ts';
import type { SpeechOutputResult, SpeechSegment } from './types.ts';

export interface QueueEntry {
  segment: SpeechSegment;
  resolve: (receipt: SpeechReceipt) => void;
  reject: (error: unknown) => void;
  settled: boolean;
  controller: AbortController;
  /** Speaking order, kept when a held line goes back into the queue. */
  order: number;
  /** The output reported this line's audio reaching the carrier. */
  sent?: boolean;
  /** The output is playing this line (its prepare has returned). */
  playing?: boolean;
  /** P1: hold() took this line back before its audio reached the carrier. */
  held?: boolean;
  /** The output was asked to prepare this line while it was held. */
  prepared?: boolean;
  /** SpeechPlayout: when its audio reached the carrier, the line still playing ahead of it then, */
  sentAt?: number;
  behind?: QueueEntry;
  /** and when and how it settled. */
  endedAt?: number;
  completed?: boolean;
}

/** Settles promises, queue budgets and terminal evidence exactly once. */
export class SpeechSettlement {
  constructor(
    private readonly budget: SpeechQueueBudget,
    private readonly evidence: SpeechEvidenceHistory,
    private readonly playout: SpeechPlayout,
  ) {}

  /** Playback returned; a line no longer `current` (aborted, or its epoch ended) was interrupted. */
  finished(entry: QueueEntry, result: SpeechOutputResult, current: boolean): void {
    if (current && result.state !== 'interrupted') this.played(entry, result);
    else this.interrupted(entry, 'playback interrupted', result.evidence);
  }

  played(entry: QueueEntry, result: SpeechOutputResult): void {
    this.settle(entry, {
      id: entry.segment.id,
      text: entry.segment.text,
      epoch: entry.segment.epoch,
      state: 'completed',
      evidence: result.evidence,
    });
    this.evidence.record(entry.segment, 'completed', result.evidence);
  }

  interrupted(
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

  /** Playback threw: a failure rejects the line, an abort or a timeout interrupts it. */
  async failed(
    entry: QueueEntry,
    signal: AbortSignal,
    error: unknown,
    interrupt: (epoch: number) => Promise<void>,
  ): Promise<void> {
    if (!signal.aborted && !isAbortError(error)) {
      this.evidence.record(entry.segment, 'failed', 'generated', errorMessage(error));
      this.reject(entry, error);
      return;
    }
    if (signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError') {
      try {
        await interrupt(entry.segment.epoch);
      } catch (interruptError) {
        this.evidence.record(
          entry.segment,
          'failed',
          'generated',
          `playback timeout flush failed: ${errorMessage(interruptError)}`,
        );
      }
    }
    this.interrupted(entry, errorMessage(signal.reason ?? 'speech playback aborted'));
  }

  reject(entry: QueueEntry, error: unknown): void {
    if (entry.settled) return;
    entry.settled = true;
    this.budget.remove(entry.segment.text);
    entry.reject(error);
  }

  private settle(entry: QueueEntry, receipt: SpeechReceipt): void {
    if (entry.settled) return;
    entry.settled = true;
    this.budget.remove(entry.segment.text);
    const playedMs = this.playout.settled(entry, receipt.state === 'completed');
    entry.resolve(playedMs === undefined ? receipt : { ...receipt, playedMs });
  }
}
