import type { SpeechOutputResult } from '@winsendotai/ovo-contracts';

export const VOICE_SERVICE_KEYS = Object.freeze({
  output: 'ovo.speech-output',
  speech: 'ovo.speech',
  scheduler: 'ovo.speech-scheduler',
});

export const VOICE_PLUGIN_IDS = Object.freeze({
  scheduler: '@winsendotai/ovo-plugin-voice-scheduler',
  simulatedOutput: '@winsendotai/ovo-plugin-speech-output-simulated',
});

/** Moved to contracts (`voice/evidence.ts`, `voice/output.ts`); re-exported so existing imports keep working. */
export type {
  SpeechEvidence,
  SpeechEvidencePhase,
  SpeechKind,
  SpeechOutput,
  SpeechOutputResult,
  SpeechSegment,
} from '@winsendotai/ovo-contracts';
export interface SpeechSchedulerConfig {
  maxQueuedSegments?: number;
  maxQueuedCharacters?: number;
  maxEvidenceEntries?: number;
  playbackTimeoutMs?: number;
}

export interface SimulatedSpeechOutputConfig {
  latencyMs?: number;
  evidence?: SpeechOutputResult['evidence'];
}

export class SpeechQueueOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpeechQueueOverflowError';
  }
}

export class SpeechSchedulerDisposedError extends Error {
  constructor() {
    super('Speech scheduler is disposed');
    this.name = 'SpeechSchedulerDisposedError';
  }
}

export class SpeechEpochError extends Error {
  constructor(requested: number, current: number) {
    super(`Speech epoch ${requested} is not current (current epoch: ${current})`);
    this.name = 'SpeechEpochError';
  }
}
