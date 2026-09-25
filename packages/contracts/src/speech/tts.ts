import type { AudioFormat } from '../audio.ts';
import type { UsageSink } from '../usage.ts';
import type { SpeechKindV2 } from '../voice/evidence.ts';
import type { SpeechCapabilities } from './capabilities.ts';

export interface SynthesisInput {
  sessionId: string;
  text: string;
  format: AudioFormat;
  language: string;
  voice?: string;
  kind?: SpeechKindV2;
  signal: AbortSignal;
  onUsage: UsageSink;
}

/** TTS v2 (capability `ovo.tts-streaming@2`). */
export interface TextToSpeech {
  readonly capabilities: SpeechCapabilities;
  /** Delegated with the REQUESTED format so plugins keep stable cache revisions. */
  cacheIdentity(
    format: AudioFormat,
    voice?: string,
  ): { provider: string; model: string; voice: string; revision: string };
  /** Bytes in exactly `format`. */
  synthesize(input: SynthesisInput): AsyncIterable<Uint8Array>;
  open?(input: Omit<SynthesisInput, 'text'>): Promise<IncrementalTts>;
}

export interface IncrementalTts {
  push(text: string): void;
  flush(): void;
  audio: AsyncIterable<Uint8Array>;
  close(): Promise<void>;
}
