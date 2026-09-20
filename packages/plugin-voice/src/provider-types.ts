export type VoiceCodec = 'audio/x-mulaw';

export interface TranscriptRevision {
  revision: number;
  text: string;
  isFinal: boolean;
  speechFinal: boolean;
  speechStarted?: boolean;
  confidence?: number;
  startMs?: number;
  durationMs?: number;
}

export interface StreamingSttSession {
  write(audio: Uint8Array, signal?: AbortSignal): Promise<void>;
  finish(signal?: AbortSignal): Promise<void>;
  close(reason: string): Promise<void>;
}

export interface StreamingStt {
  start(input: {
    sessionId: string;
    codec: VoiceCodec;
    sampleRate: 8000;
    language: string;
    signal: AbortSignal;
    onTranscript: (revision: TranscriptRevision) => void;
  }): Promise<StreamingSttSession>;
}

export interface StreamingTts {
  synthesize(input: {
    sessionId: string;
    text: string;
    codec: VoiceCodec;
    sampleRate: 8000;
    voice?: string;
    signal: AbortSignal;
  }): AsyncIterable<Uint8Array>;
}

export interface VoiceMediaTransport {
  readonly sessionId: string;
  readonly bufferedBytes: number;
  sendAudio(audio: Uint8Array, signal?: AbortSignal): Promise<void>;
  sendMark(name: string, signal?: AbortSignal): Promise<void>;
  clear(signal?: AbortSignal): Promise<void>;
  onAudio(listener: (audio: Uint8Array, timestampMs: number) => void): () => void;
  onMark(listener: (name: string) => void): () => void;
  onDtmf(listener: (digit: string) => void): () => void;
  onClose(listener: (reason: string) => void): () => void;
  close(reason: string): Promise<void>;
}

export interface VoiceProviderUsage {
  provider: string;
  requestId?: string;
  unit: 'audio_seconds' | 'characters' | 'tokens';
  quantity: number;
  estimated: boolean;
}
