/** Moved from `plugin-voice/src/types.ts`. */
export type SpeechKind = 'acknowledgment' | 'response' | 'progress';

/** v2 speech kinds. Turn detectors use them for mute rules (§2.7). */
export type SpeechKindV2 =
  'acknowledgment' | 'response' | 'progress' | 'confirmation' | 'disclosure' | 'idle-prompt';

export interface SpeechSegment {
  id: string;
  text: string;
  epoch: number;
  kind: SpeechKind;
  generatedAt: number;
}

export type SpeechEvidencePhase =
  | 'generated'
  | 'queued'
  | 'started'
  | 'sent'
  | 'acknowledged'
  | 'completed'
  | 'interrupted'
  | 'dropped'
  | 'failed';

export interface SpeechEvidence {
  sequence: number;
  segmentId: string;
  text: string;
  epoch: number;
  kind: SpeechKind;
  phase: SpeechEvidencePhase;
  at: number;
  evidence: 'generated' | 'simulated' | 'estimated' | 'confirmed';
  reason?: string;
}
