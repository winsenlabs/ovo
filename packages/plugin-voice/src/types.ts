export const VOICE_SERVICE_KEYS = Object.freeze({
  output: 'ovo.speech-output',
  speech: 'ovo.speech',
  scheduler: 'ovo.speech-scheduler',
});

export const VOICE_PLUGIN_IDS = Object.freeze({
  scheduler: '@winsendotai/ovo-plugin-voice-scheduler',
  simulatedOutput: '@winsendotai/ovo-plugin-speech-output-simulated',
});

export type SpeechKind = 'acknowledgment' | 'response' | 'progress';

export interface SpeechSegment {
  id: string;
  text: string;
  epoch: number;
  kind: SpeechKind;
  generatedAt: number;
}

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
