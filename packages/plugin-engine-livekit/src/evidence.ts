import type {
  EngineEvent,
  SpeechEvidencePhase,
  SpeechReceipt,
  SpeechSegment,
  TranscriptObserver,
} from '@winsendotai/ovo-contracts';
import type { Clock } from '@winsendotai/ovo-contracts';

export class Evidence {
  private sequence = 0;
  private readonly listeners = new Set<(event: EngineEvent) => void>();
  constructor(
    readonly clock: Clock,
    private readonly transcripts?: TranscriptObserver,
  ) {}
  subscribe(fn: (event: EngineEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  emit(event: EngineEvent): void {
    // Observers cannot own the engine lifecycle or suppress another observer.
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {}
    }
    if (event.type === 'agent.transcript' || event.type === 'user.transcript')
      try {
        this.transcripts?.(event);
      } catch {}
  }
  phase(
    segment: SpeechSegment,
    phase: SpeechEvidencePhase,
    evidence: 'generated' | SpeechReceipt['evidence'] = 'generated',
  ): void {
    this.emit({
      type: 'speech',
      evidence: {
        sequence: ++this.sequence,
        segmentId: segment.id,
        text: segment.text,
        epoch: segment.epoch,
        kind: segment.kind,
        phase,
        evidence,
        at: this.clock.now(),
      },
    });
    if (phase === 'generated' || phase === 'completed' || phase === 'interrupted')
      this.emit({
        type: 'agent.transcript',
        segmentId: segment.id,
        text: segment.text,
        state: phase === 'completed' ? 'played' : phase,
      });
    if (phase === 'sent' || phase === 'acknowledged')
      this.emit({
        type: 'timing',
        key: phase === 'sent' ? 'carrier_first_audio' : 'playout_ack',
        segmentId: segment.id,
        atMs: this.clock.now(),
      });
  }
}
