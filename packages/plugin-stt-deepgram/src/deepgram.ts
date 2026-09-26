import {
  MULAW_8K,
  PCM16_8K,
  PCM16_16K,
  sameFormat,
  type AudioFormat,
  type Clock,
  type NetPort,
  type SpeechToText,
  type SttSession,
} from '@winsendotai/ovo-contracts';
import { openProviderSocket, syntheticRequestId, systemClock } from '@winsendotai/ovo-plugin-kit';
import { DeepgramSession } from './session.ts';

export interface DeepgramConfig {
  model: string;
  language?: string;
  endpointingMs?: number;
  utteranceEndMs?: number;
  keyterms?: string[];
}

export const DEEPGRAM_CAPABILITIES = Object.freeze({
  inputFormats: [MULAW_8K, PCM16_8K, PCM16_16K],
  languages: ['en', 'en-IN', 'hi', 'multi'],
  interim: true,
  wordTimestamps: true,
  turnSignals: ['speech-start', 'end-of-turn', 'utterance-end'] as const,
  forceEndpoint: true,
  ttfsP99Ms: 350,
});

export class DeepgramStt implements SpeechToText {
  readonly capabilities = DEEPGRAM_CAPABILITIES;
  private readonly binding: DeepgramConfig;
  private requestNumber = 0;

  constructor(
    private readonly net: NetPort,
    private readonly apiKey: string,
    binding: DeepgramConfig = { model: 'nova-3' },
    private readonly clock: Clock = systemClock,
  ) {
    this.binding = Object.freeze(structuredClone(binding));
  }

  async start(input: Parameters<SpeechToText['start']>[0]): Promise<SttSession> {
    if (!this.capabilities.inputFormats.some((format) => sameFormat(format, input.format)))
      throw new TypeError('Deepgram requires a native input format');
    const requestId = syntheticRequestId('deepgram', input.sessionId, ++this.requestNumber);
    const url = listenUrl(input.format, input.language, this.binding);
    const socket = await openProviderSocket(
      this.net,
      url,
      { Authorization: `Token ${this.apiKey}` },
      ['api.deepgram.com'],
      { signal: input.signal, clock: this.clock },
    );
    return new DeepgramSession(socket, input, this.clock, requestId);
  }
}

export function listenUrl(format: AudioFormat, language: string, binding: DeepgramConfig): string {
  const url = new URL('wss://api.deepgram.com/v1/listen');
  url.searchParams.set('model', binding.model || 'nova-3');
  url.searchParams.set('language', binding.language ?? language);
  url.searchParams.set('encoding', format.encoding === 'mulaw' ? 'mulaw' : 'linear16');
  url.searchParams.set('sample_rate', String(format.sampleRate));
  url.searchParams.set('channels', '1');
  url.searchParams.set('interim_results', 'true');
  url.searchParams.set('vad_events', 'true');
  url.searchParams.set('utterance_end_ms', String(binding.utteranceEndMs ?? 1000));
  url.searchParams.set('endpointing', String(binding.endpointingMs ?? 300));
  url.searchParams.set('punctuate', 'true');
  url.searchParams.set('smart_format', 'true');
  for (const term of binding.keyterms ?? []) url.searchParams.append('keyterm', term);
  return url.href;
}
