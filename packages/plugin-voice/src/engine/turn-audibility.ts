import type { SpeechEvidence } from '@winsendotai/ovo-contracts';

/** Evidence that a line's audio reached the carrier (an output may report only the later ones). */
const AUDIBLE = new Set<SpeechEvidence['phase']>(['sent', 'acknowledged', 'completed']);

/**
 * Which reply epochs the caller has started to hear (AGT-10). A filler line (LAT-6) holds the floor
 * but answers nothing, so its audio leaves the epoch unanswered.
 */
export class ReplyAudibility {
  private readonly heard = new Set<number>();
  /** Filler lines not yet finished, and their epochs. */
  private readonly fillers = new Map<string, number>();
  private capturing = false;
  /** As in SpeechEventProjector: until the output reports 'sent', a started line counts as heard. */
  private reportsAudio = false;

  /** Feed every scheduler evidence record, in order. */
  observe(evidence: SpeechEvidence): void {
    if (evidence.phase === 'sent') this.reportsAudio = true;
    const audible =
      AUDIBLE.has(evidence.phase) || (evidence.phase === 'started' && !this.reportsAudio);
    if (evidence.phase === 'generated' && this.capturing)
      this.fillers.set(evidence.segmentId, evidence.epoch);
    else if (audible && !this.fillers.has(evidence.segmentId)) {
      this.heard.add(evidence.epoch);
      for (const epoch of this.heard) if (epoch < evidence.epoch - 4) this.heard.delete(epoch);
    }
    if (
      evidence.phase === 'completed' ||
      evidence.phase === 'interrupted' ||
      evidence.phase === 'dropped' ||
      evidence.phase === 'failed'
    )
      this.fillers.delete(evidence.segmentId);
  }

  /** True once the caller has heard any of this epoch's answer. */
  answered(epoch: number | undefined): boolean {
    return epoch !== undefined && this.heard.has(epoch);
  }

  /** True while the line is a filler that has not finished. */
  isFiller(segmentId: string): boolean {
    return this.fillers.has(segmentId);
  }

  /** True while a filler line of this epoch is queued or playing (P3). */
  fillerPending(epoch: number): boolean {
    for (const fillerEpoch of this.fillers.values()) if (fillerEpoch === epoch) return true;
    return false;
  }

  /** Runs `speak`, marking the line it schedules (synchronously) as a filler. */
  filler<T>(speak: () => T): T {
    this.capturing = true;
    try {
      return speak();
    } finally {
      this.capturing = false;
    }
  }
}
