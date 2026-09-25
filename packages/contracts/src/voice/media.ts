import type { AudioFormat } from '../audio.ts';
import type { EndReason } from './end-reason.ts';

/** How strongly the carrier attests that audio was played (§0.2, §2.5). */
export type PlaybackEvidence = 'carrier-played' | 'carrier-processed' | 'none';

/** v2 of `VoiceMediaTransport`. The recording tap wraps it; it is carrier-neutral. */
export interface MediaDuplex {
  readonly sessionId: string;
  readonly carrierId: string;
  readonly format: AudioFormat;
  readonly playbackEvidence: PlaybackEvidence;
  readonly clearFlushesMarkers: boolean | 'unknown';
  readonly bufferedBytes: number;
  sendAudio(bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
  mark(name: string, signal?: AbortSignal): Promise<void>;
  clear(signal?: AbortSignal): Promise<void>;
  onAudio(fn: (bytes: Uint8Array, tsMs: number) => void): () => void;
  /** Twilio mark, Plivo playedStream, Exotel mark. */
  onPlayed(fn: (name: string) => void): () => void;
  onCleared(fn: () => void): () => void;
  onDtmf(fn: (digit: string) => void): () => void;
  onAnsweredBy?(fn: (value: 'human' | 'machine' | 'unknown') => void): () => void;
  onClose(fn: (reason: EndReason) => void): () => void;
  close(reason: EndReason): Promise<void>;
}
