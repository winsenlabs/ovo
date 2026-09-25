import {
  MULAW_8K,
  PCM16_8K,
  PCM16_16K,
  sameFormat,
  type Clock,
  type NetPort,
  type SpeechToText,
  type SttSession,
} from '@winsendotai/ovo-contracts';
import { systemClock } from '@winsendotai/ovo-plugin-kit';
import { createSarvamSttSession } from './stt-session.ts';

export interface SarvamSttBinding {
  model?: string;
  mode?: 'transcribe' | 'translate' | 'verbatim' | 'translit' | 'codemix';
  languageCode?: string;
  streamType?: 'fast' | 'balanced';
  silenceDurationMs?: number;
  endpointing?: 'vad' | 'manual';
}

const languages = [
  'as-IN',
  'bn-IN',
  'brx-IN',
  'doi-IN',
  'en-IN',
  'gu-IN',
  'hi-IN',
  'kn-IN',
  'ks-IN',
  'kok-IN',
  'mai-IN',
  'ml-IN',
  'mni-IN',
  'mr-IN',
  'ne-IN',
  'or-IN',
  'pa-IN',
  'sa-IN',
  'sat-IN',
  'sd-IN',
  'ta-IN',
  'te-IN',
  'ur-IN',
];

export const SARVAM_STT_CAPABILITIES = Object.freeze({
  inputFormats: [MULAW_8K, PCM16_8K, PCM16_16K],
  frameMs: { min: 20, max: 1000, preferred: 100 },
  languages,
  interim: true,
  wordTimestamps: false,
  turnSignals: ['speech-start', 'speech-end', 'end-of-turn'] as const,
  forceEndpoint: false,
  ttfsP99Ms: 1000,
});

export function sarvamSttUrl(
  binding: SarvamSttBinding,
  input: Parameters<SpeechToText['start']>[0],
): string {
  const url = new URL('wss://api.sarvam.ai/speech-to-text-realtime/ws');
  url.searchParams.set('model', binding.model ?? 'saaras:v3-realtime');
  url.searchParams.set('mode', binding.mode ?? 'transcribe');
  url.searchParams.set('language_code', binding.languageCode ?? input.language);
  url.searchParams.set('stream_type', binding.streamType ?? 'balanced');
  url.searchParams.set('sample_rate', String(input.format.sampleRate));
  url.searchParams.set('encoding', input.format.encoding === 'mulaw' ? 'mulaw' : 'linear16');
  url.searchParams.set('silence_duration_ms', String(binding.silenceDurationMs ?? 500));
  url.searchParams.set('endpointing', binding.endpointing ?? 'vad');
  return url.toString();
}

export class SarvamStt implements SpeechToText {
  readonly capabilities;
  readonly binding: Readonly<SarvamSttBinding>;

  constructor(
    private readonly net: NetPort,
    private readonly key: string,
    binding: SarvamSttBinding = {},
    private readonly clock: Clock = systemClock,
  ) {
    this.binding = Object.freeze(structuredClone(binding));
    this.capabilities = {
      ...SARVAM_STT_CAPABILITIES,
      languages:
        binding.languageCode && binding.languageCode !== 'auto'
          ? [binding.languageCode]
          : languages,
      forceEndpoint: binding.endpointing === 'manual',
    };
  }

  async start(input: Parameters<SpeechToText['start']>[0]): Promise<SttSession> {
    if (!this.capabilities.inputFormats.some((format) => sameFormat(format, input.format)))
      throw new TypeError('Sarvam STT requires native 8 or 16 kHz mono audio');
    if (!languages.includes(input.language) && input.language !== 'auto')
      throw new TypeError(`Sarvam STT does not support ${input.language}`);
    if (
      this.binding.languageCode &&
      this.binding.languageCode !== 'auto' &&
      this.binding.languageCode !== input.language
    )
      throw new TypeError(
        `Sarvam STT binding language ${this.binding.languageCode} conflicts with ${input.language}`,
      );
    input.signal.throwIfAborted();
    const socket = this.net.websocket(sarvamSttUrl(this.binding, input), {
      headers: { 'api-subscription-key': this.key },
    });
    const session = createSarvamSttSession(socket, input, this.binding, this.clock);
    await session.ready;
    return session;
  }
}
