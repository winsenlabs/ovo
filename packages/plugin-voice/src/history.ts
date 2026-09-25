import type {
  SpeechEvidence,
  SpeechEvidencePhase,
  SpeechOutputResult,
  SpeechSegment,
} from './types.ts';

export class SpeechEvidenceHistory {
  readonly entries: SpeechEvidence[] = [];
  private readonly listeners = new Set<(evidence: SpeechEvidence) => void>();
  private sequence = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  subscribe(listener: (evidence: SpeechEvidence) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  record(
    segment: SpeechSegment,
    phase: SpeechEvidencePhase,
    evidence: SpeechOutputResult['evidence'] | 'generated',
    reason?: string,
  ): void {
    const item = Object.freeze({
      sequence: ++this.sequence,
      segmentId: segment.id,
      text: segment.text,
      epoch: segment.epoch,
      kind: segment.kind,
      phase,
      at: this.now(),
      evidence,
      ...(reason ? { reason } : {}),
    });
    this.entries.push(item);
    if (this.entries.length > this.maxEntries)
      this.entries.splice(0, this.entries.length - this.maxEntries);
    for (const listener of this.listeners) listener(item);
  }

  clearListeners(): void {
    this.listeners.clear();
  }
}
