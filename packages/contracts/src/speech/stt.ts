import type { AudioFormat } from '../audio.ts';
import type { UsageSink } from '../usage.ts';
import type { SpeechCapabilities } from './capabilities.ts';

/**
 * Interim revisions of one segmentId REPLACE each other; 'final' locks the segment.
 * The turn aggregator appends finals in order, idempotent on segmentId. Never dedupe by text.
 */
export interface TranscriptSegment {
  segmentId: string;
  /** Monotonic per session. */
  revision: number;
  text: string;
  stability: 'interim' | 'final';
  formatted?: boolean;
  confidence?: number;
  language?: string;
  startMs?: number;
  endMs?: number;
  words?: readonly { text: string; startMs: number; endMs: number; final: boolean }[];
}

export type SttEvent =
  | { type: 'transcript'; segment: TranscriptSegment }
  | { type: 'speech-start' | 'speech-end' | 'utterance-end'; atMs?: number }
  | { type: 'end-of-turn'; eager?: boolean; confidence?: number }
  | { type: 'turn-resumed' };

/** STT v2 (capability `ovo.stt@2`). The host format adapter wraps it; plugins never resample. */
export interface SpeechToText {
  readonly capabilities: SpeechCapabilities;
  start(input: {
    sessionId: string;
    format: AudioFormat;
    language: string;
    signal: AbortSignal;
    onEvent(event: SttEvent): void;
    onUsage: UsageSink;
  }): Promise<SttSession>;
}

export interface SttSession {
  write(frame: Uint8Array, signal?: AbortSignal): Promise<void>;
  forceEndpoint?(): Promise<void>;
  /** Graceful; reconciled usage when available. */
  finish(signal?: AbortSignal): Promise<void>;
  /** Immediate. Usage is emitted EXACTLY once across finish, cancel and failure. */
  cancel(reason: string): Promise<void>;
}
