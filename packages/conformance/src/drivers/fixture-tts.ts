import { usageOnce } from '@winsendotai/ovo-plugin-kit';
import {
  MULAW_8K,
  PCM16_16K,
  sameFormat,
  type Clock,
  type FixtureTemplate,
  type NetFixtureStep,
  type NetPort,
  type SpeechCapabilities,
  type SynthesisInput,
  type TextToSpeech,
} from '@winsendotai/ovo-contracts';
import { speechBytes } from './audio-gen.ts';
import { FIXTURE_DOCS, FIXTURE_HOST, FIXTURE_RETRIEVED } from './fixture-stt.ts';

const TTS_URL = `https://${FIXTURE_HOST}/v1/tts`;

export const FIXTURE_TTS_CAPABILITIES: SpeechCapabilities = Object.freeze({
  outputFormats: Object.freeze([MULAW_8K, PCM16_16K]),
  languages: Object.freeze(['*']),
  interim: false,
  wordTimestamps: false,
  turnSignals: Object.freeze([]),
  forceEndpoint: false,
  maxChars: 4096,
});

/** Audio length the fixture TTS server returns for `text` (4 ms per character, at least 60 ms). */
export const fixtureTtsMs = (text: string) => Math.max(60, text.length * 4);

/** The fixture TTS: POSTs JSON to https://fixture.invalid/v1/tts and streams the audio body. */
export class FixtureTextToSpeech implements TextToSpeech {
  readonly capabilities = FIXTURE_TTS_CAPABILITIES;

  constructor(
    private readonly net: NetPort,
    private readonly options: { clock?: Clock } = {},
  ) {}

  cacheIdentity(format: SynthesisInput['format'], voice?: string) {
    return {
      provider: 'fixture',
      model: 'fixture-tts-1',
      voice: voice ?? 'fixture-voice',
      revision: `fixture-tts-${format.encoding}-${format.sampleRate}-v1`,
    };
  }

  async *synthesize(input: SynthesisInput): AsyncIterable<Uint8Array> {
    if (!this.capabilities.outputFormats!.some((f) => sameFormat(f, input.format)))
      throw new TypeError('fixture TTS: non-native output format');
    const usage = usageOnce(input.onUsage);
    const startedAt = this.options.clock?.now() ?? Date.now();
    let requestId = `fixture:${input.sessionId}:tts`;
    const emitUsage = () =>
      usage.emit({
        provider: 'fixture',
        operation: 'tts',
        unit: 'characters',
        quantity: String(input.text.length),
        state: 'estimated',
        requestId,
        elapsedMs: (this.options.clock?.now() ?? Date.now()) - startedAt,
      });
    try {
      const response = await this.net.fetch(TTS_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Token fixture' },
        body: JSON.stringify({
          text: input.text,
          voice: input.voice ?? 'fixture-voice',
          encoding: input.format.encoding,
          sample_rate: input.format.sampleRate,
        }),
        signal: input.signal,
      });
      requestId = response.headers.get('x-request-id') ?? requestId;
      if (!response.ok || !response.body)
        throw new Error(`fixture TTS failed with ${response.status}`);
      const reader = response.body.getReader();
      try {
        for (;;) {
          input.signal.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) break;
          input.signal.throwIfAborted();
          yield value;
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    } finally {
      emitUsage();
    }
  }
}

/** One scripted POST per agent text, answered with speech-like audio in the requested format. */
export const fixtureTtsTemplate: FixtureTemplate = (input) => {
  const steps: NetFixtureStep[] = (input.agentTexts ?? []).map((text, index) => {
    const audio = speechBytes(input.format, fixtureTtsMs(text), index + 1);
    const half = Math.floor(audio.byteLength / 2) | 1;
    return {
      expect: 'http',
      method: 'POST',
      url: TTS_URL,
      body: 'json',
      where: { text, encoding: input.format.encoding, sample_rate: input.format.sampleRate },
      reply: {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'x-request-id': `fixture-tts-${index + 1}`,
        },
        chunks: [
          { base64: Buffer.from(audio.subarray(0, half)).toString('base64') },
          { base64: Buffer.from(audio.subarray(half)).toString('base64') },
        ],
      },
    } as NetFixtureStep;
  });
  return [
    { host: FIXTURE_HOST, source: `${FIXTURE_DOCS}/tts`, retrieved: FIXTURE_RETRIEVED, steps },
  ];
};
