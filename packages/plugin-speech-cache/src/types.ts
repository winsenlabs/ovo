import type { SpeechKind, SpeechOutputResult, SpeechSegment } from '@winsendotai/ovo-plugin-voice';

export const SPEECH_CACHE_SERVICE_KEYS = Object.freeze({
  cache: 'ovo.cache',
  tts: 'ovo.tts',
  audioPlayer: 'ovo.audio-player',
  output: 'ovo.speech-output',
});

export const SPEECH_CACHE_PLUGIN_ID = '@winsendotai/ovo-plugin-speech-cache-output';

export interface SpeechSynthesisBinding {
  workspaceId: string;
  provider: string;
  bindingVersion: string;
  model: string;
  voice: string;
  locale: string;
  codec: string;
  sampleRate: number;
  pronunciation: string;
  prosodyRevision: string;
  optionsRevision: string;
}

export interface ApprovedSpeechPhrase {
  text: string;
  purpose: 'static-phrase' | 'announcement';
}

export interface SpeechCacheOutputConfig extends SpeechSynthesisBinding {
  /** Required before response-kind phrases may use announcement caching. */
  announcementMode?: boolean;
  approvedPhrases?: ApprovedSpeechPhrase[];
}

export interface TtsSynthesisRequest extends SpeechSynthesisBinding {
  text: string;
}

export interface NativeUsage {
  provider: string;
  requestId: string;
  quantity: string;
  unit: string;
  state: 'estimated' | 'reconciled';
}

export interface TtsSynthesisResult {
  audio: Uint8Array;
  usage: NativeUsage;
}

export interface NormalizedTts {
  synthesize(
    request: TtsSynthesisRequest,
    options: { signal: AbortSignal },
  ): Promise<TtsSynthesisResult>;
}

export interface PlaybackUsage extends NativeUsage {
  source: 'carrier' | 'media';
}

export interface AudioPlaybackRequest {
  audio: Uint8Array;
  codec: string;
  sampleRate: number;
  segment: SpeechSegment;
}

export interface AudioPlayer {
  play(
    request: AudioPlaybackRequest,
    options: {
      signal: AbortSignal;
      report?: (phase: 'sent' | 'acknowledged', evidence: 'estimated' | 'confirmed') => void;
    },
  ): Promise<SpeechOutputResult & { usage: readonly PlaybackUsage[] }>;
  interrupt(epoch: number): Promise<void>;
}

export type SpeechCacheTelemetry =
  | {
      type: 'cache';
      outcome: 'hit' | 'miss' | 'coalesced' | 'bypass';
      segmentId: string;
      kind: SpeechKind;
      at: number;
      audioBytes?: number;
    }
  | {
      type: 'usage';
      phase: 'generation' | 'playback';
      segmentId: string;
      at: number;
      usage: NativeUsage & { source: 'tts-generation' | 'carrier' | 'media' };
    };

export type SpeechCacheTelemetrySink = (event: SpeechCacheTelemetry) => void;
