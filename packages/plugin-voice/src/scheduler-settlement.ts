import type { SpeechReceipt } from '@winsendotai/ovo-contracts';
import type { SpeechQueueBudget } from './budgets.ts';
import type { SpeechEvidenceHistory } from './history.ts';
import type { SpeechOutputResult, SpeechSegment } from './types.ts';

export interface QueueEntry {
  segment: SpeechSegment;
  resolve: (receipt: SpeechReceipt) => void;
  reject: (error: unknown) => void;
  settled: boolean;
  controller: AbortController;
}

/** Settles promises, queue budgets and terminal evidence exactly once. */
export class SpeechSettlement {
  constructor(
    private readonly budget: SpeechQueueBudget,
    private readonly evidence: SpeechEvidenceHistory,
  ) {}

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
    entry.resolve(receipt);
  }
}
