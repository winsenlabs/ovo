import type { AudioFormat } from '../audio.ts';

export type TurnSignal =
  | 'speech-start'
  | 'speech-end'
  | 'end-of-turn'
  | 'eager-end-of-turn'
  | 'utterance-end'
  | 'turn-resumed';

export interface SpeechCapabilities {
  /** STT: native formats, in preference order. */
  inputFormats?: readonly AudioFormat[];
  /** TTS: native formats, in preference order. */
  outputFormats?: readonly AudioFormat[];
  /** For example AssemblyAI {min: 50, max: 1000, preferred: 100}. */
  frameMs?: { min: number; max: number; preferred: number };
  /** BCP-47 tags, or '*'. */
  languages: readonly string[];
  interim: boolean;
  wordTimestamps: boolean;
  turnSignals: readonly TurnSignal[];
  forceEndpoint: boolean;
  ttfsP99Ms?: number;
  incrementalText?: boolean;
  maxChars?: number;
}
