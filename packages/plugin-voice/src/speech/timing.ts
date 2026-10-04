import type { SpeechSegment } from '@winsendotai/ovo-contracts';

export type SpeechTimingPhase = 'text-ready' | 'tts-first-byte' | 'carrier-first-audio';
export type SpeechTimingSink = (
  phase: SpeechTimingPhase,
  segment: SpeechSegment,
  elapsedMs?: number,
) => void;
