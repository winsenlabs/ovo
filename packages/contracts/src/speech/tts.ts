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
  /**
   * One provider context for every segment of one agent reply (LAT-5). Speech output opens it on
   * the reply's first segment and closes it on barge-in or once the reply has gone quiet; without
   * it, each segment is its own `open()` or `synthesize()`.
   */
  openReply?(input: Omit<SynthesisInput, 'text'>): Promise<TtsReply>;
  /**
   * Connects ahead of the first utterance, at session start. Best effort: it never rejects, and
   * a failed warm-up leaves the first `open()` to connect (or fall back) as it would have anyway.
   */
  warm?(input: { format: AudioFormat; voice?: string }): Promise<void>;
}

export interface IncrementalTts {
  push(text: string): void;
  flush(): void;
  audio: AsyncIterable<Uint8Array>;
  close(): Promise<void>;
}

/**
 * An agent reply rendered in one provider context. Segments are whole sentences or clauses: the
 * guardrail and text filters have already run on each, so nothing unchecked reaches the provider.
 */
export interface TtsReply {
  /**
   * Appends one segment and asks the provider to render it now. The iterable yields exactly that
   * segment's audio, after every earlier segment's, so each one keeps its own playback mark.
   * Aborting `signal` drops the rest of this segment's audio; the reply goes on.
   */
  segment(text: string, signal: AbortSignal): AsyncIterable<Uint8Array>;
  /** Closes the provider context (barge-in, or the reply is over). Unfinished segments end. */
  close(): Promise<void>;
}
