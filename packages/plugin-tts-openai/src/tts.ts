import {
  PCM16_24K,
  sameFormat,
  type Clock,
  type NetPort,
  type SynthesisInput,
  type TextToSpeech,
  type UsageMeter,
} from '@winsendotai/ovo-contracts';
import {
  assertSuccessful,
  decimal,
  sseReader,
  syntheticRequestId,
  systemClock,
  usageOnce,
} from '@winsendotai/ovo-plugin-kit';

export type OpenAiTtsModel =
  'gpt-4o-mini-tts' | 'gpt-4o-mini-tts-2025-12-15' | 'tts-1' | 'tts-1-hd';
export interface OpenAiTtsConfig {
  model: OpenAiTtsModel;
  voice: string;
  instructions?: string;
  speed?: number;
}

export const OPENAI_TTS_CAPABILITIES = Object.freeze({
  outputFormats: [PCM16_24K],
  languages: ['*'],
  interim: false,
  wordTimestamps: false,
  turnSignals: [] as const,
  forceEndpoint: false,
  incrementalText: false,
  maxChars: 4096,
});

export class OpenAiTts implements TextToSpeech {
  readonly capabilities = OPENAI_TTS_CAPABILITIES;
  readonly binding: Readonly<OpenAiTtsConfig>;

  constructor(
    private readonly net: NetPort,
    private readonly apiKey: string,
    binding: OpenAiTtsConfig = { model: 'gpt-4o-mini-tts', voice: 'alloy' },
    private readonly clock: Clock = systemClock,
  ) {
    this.binding = Object.freeze(structuredClone(binding));
  }

  cacheIdentity(format: SynthesisInput['format'], voice?: string) {
    return {
      provider: 'openai',
      model: this.binding.model,
      voice: voice ?? this.binding.voice,
      revision:
        format.encoding === 'mulaw' && format.sampleRate === 8000
          ? 'openai-tts-mulaw-8000-v1'
          : `openai-tts-${format.encoding}-${format.sampleRate}-v1`,
    };
  }

  async *synthesize(input: SynthesisInput): AsyncIterable<Uint8Array> {
    if (!sameFormat(input.format, PCM16_24K))
      throw new TypeError('OpenAI TTS accepts only native PCM16 24 kHz; use the host adapter');
    if (!input.text || [...input.text].length > 4096)
      throw new TypeError('OpenAI TTS text must contain 1–4096 characters');
    input.signal.throwIfAborted();
    const startedAt = this.clock.now();
    const once = usageOnce(input.onUsage);
    const mini = this.binding.model.startsWith('gpt-4o-mini-tts');
    let receivedBytes = 0;
    let reconciled: { input: number; output: number } | undefined;
    let requestId = syntheticRequestId('openai', input.sessionId, 1);
    let pending: number | undefined;
    const emit = () => {
      const common = {
        provider: 'openai',
        operation: 'tts' as const,
        requestId,
        elapsedMs: Math.max(0, this.clock.now() - startedAt),
        state: reconciled ? ('reconciled' as const) : ('estimated' as const),
      };
      const meters: UsageMeter[] = mini
        ? [
            {
              ...common,
              unit: 'input_tokens',
              quantity: decimal(reconciled?.input ?? Math.ceil([...input.text].length / 4)),
            },
            {
              ...common,
              unit: 'audio_output_tokens',
              quantity: decimal(reconciled?.output ?? Math.ceil(receivedBytes / 480)),
            },
          ]
        : [{ ...common, unit: 'characters', quantity: decimal([...input.text].length) }];
      once.emit(meters);
    };
    const evenChunks = (bytes: Uint8Array): Uint8Array[] => {
      let joined = bytes;
      if (pending !== undefined) {
        joined = new Uint8Array(bytes.byteLength + 1);
        joined[0] = pending;
        joined.set(bytes, 1);
      }
      const even = joined.byteLength & ~1;
      pending = even < joined.byteLength ? joined[even] : undefined;
      return even ? [joined.slice(0, even)] : [];
    };
    try {
      const response = await this.net.fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.binding.model,
          voice: input.voice ?? this.binding.voice,
          input: input.text,
          response_format: 'pcm',
          ...(mini ? { stream_format: 'sse' } : {}),
          ...(mini && this.binding.instructions ? { instructions: this.binding.instructions } : {}),
          ...(this.binding.speed ? { speed: this.binding.speed } : {}),
        }),
        signal: input.signal,
      });
      await assertSuccessful(response);
      requestId = response.headers.get('x-request-id') || requestId;
      if (!response.body) throw new Error('OpenAI TTS response has no body');
      if (mini) {
        for await (const event of sseReader(cancelOnEarlyExit(response.body))) {
          input.signal.throwIfAborted();
          const data = JSON.parse(event.data) as Record<string, unknown>;
          if (data.type === 'speech.audio.delta') {
            if (typeof data.audio !== 'string') throw new Error('OpenAI speech delta has no audio');
            const bytes = decodeBase64(data.audio);
            receivedBytes += bytes.byteLength;
            for (const chunk of evenChunks(bytes)) yield chunk;
          } else if (data.type === 'speech.audio.done') {
            const usage = asRecord(data.usage);
            if (typeof usage?.input_tokens === 'number' && typeof usage.output_tokens === 'number')
              reconciled = { input: usage.input_tokens, output: usage.output_tokens };
          }
        }
      } else {
        for await (const value of cancelOnEarlyExit(response.body)) {
          input.signal.throwIfAborted();
          receivedBytes += value.byteLength;
          for (const chunk of evenChunks(value)) yield chunk;
        }
      }
      if (pending !== undefined) throw new Error('OpenAI TTS returned an incomplete PCM sample');
    } finally {
      emit();
    }
  }
}

/** A stopped synthesis must cancel the provider body; releaseLock alone leaves it streaming. */
async function* cancelOnEarlyExit(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        return;
      }
      yield value;
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
