import type { SpeechSegment } from './evidence.ts';

/** Moved from `plugin-voice/src/types.ts`. */
export interface SpeechOutputResult {
  state: 'completed' | 'interrupted';
  evidence: 'simulated' | 'estimated' | 'confirmed';
}

/** A transport/TTS adapter must treat abort as a request to stop and flush output. */
export interface SpeechOutput {
  play(
    segment: SpeechSegment,
    options: {
      signal: AbortSignal;
      report?: (phase: 'sent' | 'acknowledged', evidence: 'estimated' | 'confirmed') => void;
    },
  ): Promise<SpeechOutputResult>;
  interrupt(epoch: number): Promise<void>;
  /** Optional prefetch: start synthesis for a queued segment before it plays (#9). */
  prepare?(segment: SpeechSegment, signal: AbortSignal): Promise<void>;
}
