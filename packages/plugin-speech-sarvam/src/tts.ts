import {
  MULAW_8K,
  PCM16_8K,
  PCM16_16K,
  PCM16_24K,
  sameFormat,
  type AudioFormat,
  type Clock,
  type IncrementalTts,
  type NetPort,
  type SynthesisInput,
  type TextToSpeech,
  type UsageMeter,
} from '@winsendotai/ovo-contracts';
import { decimal, syntheticRequestId, systemClock, usageOnce } from '@winsendotai/ovo-plugin-kit';
import { decodeRestAudio } from './rest-audio.ts';
import { SarvamTtsSession } from './tts-session.ts';

export interface SarvamTtsBinding {
  model?: 'bulbul:v3' | 'bulbul:v2';
  speaker?: string;
  pace?: number;
  temperature?: number;
  dictId?: string;
  restFallback?: boolean;
}

export const SARVAM_TTS_CAPABILITIES = Object.freeze({
  outputFormats: [MULAW_8K, PCM16_8K, PCM16_16K, PCM16_24K],
  languages: [
    'bn-IN',
    'en-IN',
    'gu-IN',
    'hi-IN',
    'kn-IN',
    'ml-IN',
    'mr-IN',
    'od-IN',
    'pa-IN',
    'ta-IN',
    'te-IN',
  ],
  interim: false,
  wordTimestamps: false,
  turnSignals: [] as const,
  forceEndpoint: false,
  incrementalText: true,
  maxChars: 2500,
});

export function sarvamTtsUrl(binding: SarvamTtsBinding): string {
  const url = new URL('wss://api.sarvam.ai/text-to-speech/ws');
  url.searchParams.set('model', binding.model ?? 'bulbul:v3');
  url.searchParams.set('send_completion_event', 'true');
  return url.toString();
}

export class SarvamTts implements TextToSpeech {
  readonly capabilities = SARVAM_TTS_CAPABILITIES;
  readonly binding: Readonly<SarvamTtsBinding>;

  constructor(
    private readonly net: NetPort,
    private readonly key: string,
    binding: SarvamTtsBinding = {},
    private readonly clock: Clock = systemClock,
  ) {
    this.binding = Object.freeze(structuredClone(binding));
  }

  cacheIdentity(format: AudioFormat, voice?: string) {
    return {
      provider: 'sarvam',
      model: this.binding.model ?? 'bulbul:v3',
      voice: voice ?? this.binding.speaker ?? 'shubh',
      revision: `sarvam-${format.encoding}-${format.sampleRate}-v1`,
    };
  }

  async open(input: Omit<SynthesisInput, 'text'>): Promise<IncrementalTts> {
    if (!this.capabilities.outputFormats.some((format) => sameFormat(format, input.format)))
      throw new TypeError('Sarvam TTS requires a native mu-law or PCM16 format');
    input.signal.throwIfAborted();
    const socket = this.net.websocket(sarvamTtsUrl(this.binding), {
      headers: { 'Api-Subscription-Key': this.key },
    });
    const session = new SarvamTtsSession(socket, input, this.binding, this.clock);
    await session.ready;
    return session;
  }

  async *synthesize(input: SynthesisInput): AsyncIterable<Uint8Array> {
    if (!this.capabilities.outputFormats.some((format) => sameFormat(format, input.format)))
      throw new TypeError('Sarvam TTS requires a native mu-law or PCM16 format');
    if (!input.text || [...input.text].length > 2500)
      throw new TypeError('Sarvam TTS text must contain 1–2500 characters');
    const once = usageOnce(input.onUsage);
    const meters: UsageMeter[] = [];
    const startedAt = this.clock.now();
    let received = false;
    let restRequestId: string | undefined;
    let restSucceeded = false;
    try {
      const session = await this.open({ ...input, onUsage: (meter) => meters.push(meter) });
      try {
        session.push(input.text);
        session.flush();
        for await (const audio of session.audio) {
          input.signal.throwIfAborted();
          received = true;
          yield audio;
        }
      } finally {
        await session.close();
      }
    } catch (error) {
      if (!this.binding.restFallback || received || input.signal.aborted) throw error;
      const rest = await this.rest(input);
      restRequestId = rest.requestId;
      restSucceeded = true;
      for (const audio of rest.audios) yield audio;
    } finally {
      once.emit(
        restSucceeded
          ? {
              provider: 'sarvam',
              operation: 'tts',
              unit: 'characters',
              quantity: decimal([...input.text].length),
              state: 'reconciled',
              requestId: restRequestId ?? syntheticRequestId('sarvam', input.sessionId, 2),
              elapsedMs: Math.max(0, this.clock.now() - startedAt),
            }
          : (meters[0] ?? {
              provider: 'sarvam',
              operation: 'tts',
              unit: 'characters',
              quantity: decimal([...input.text].length),
              state: 'estimated',
              requestId: syntheticRequestId('sarvam', input.sessionId, 1),
              elapsedMs: Math.max(0, this.clock.now() - startedAt),
            }),
      );
    }
  }

  private async rest(input: SynthesisInput): Promise<{ audios: Uint8Array[]; requestId?: string }> {
    const response = await this.net.fetch('https://api.sarvam.ai/text-to-speech', {
      method: 'POST',
      headers: { 'Api-Subscription-Key': this.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: input.text,
        language_code: input.language,
        speaker: input.voice ?? this.binding.speaker ?? 'shubh',
        model: this.binding.model ?? 'bulbul:v3',
        output_audio_codec: input.format.encoding === 'mulaw' ? 'mulaw' : 'linear16',
        speech_sample_rate: input.format.sampleRate,
      }),
      signal: input.signal,
    });
    if (!response.ok) throw new Error(`Sarvam TTS REST failed (${response.status})`);
    const body = (await response.json()) as { audios?: unknown; request_id?: unknown };
    if (
      !Array.isArray(body.audios) ||
      !body.audios.length ||
      !body.audios.every((audio) => typeof audio === 'string')
    )
      throw new Error('Sarvam TTS REST returned no audio');
    return {
      audios: (body.audios as string[]).map((audio) => decodeRestAudio(audio, input.format)),
      requestId:
        typeof body.request_id === 'string' && body.request_id ? body.request_id : undefined,
    };
  }
}
