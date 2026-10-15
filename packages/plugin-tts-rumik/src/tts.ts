import {
  MULAW_8K,
  PCM16_24K,
  sameFormat,
  type AudioFormat,
  type Clock,
  type Logger,
  type NetPort,
  type SynthesisInput,
  type TextToSpeech,
  type TtsReply,
} from '@winsendotai/ovo-contracts';
import { syntheticRequestId, systemClock } from '@winsendotai/ovo-plugin-kit';
import {
  audioFormatOf,
  billedCharacters,
  cacheIdentity,
  spokenText,
  textLimit,
  type RumikTtsBinding,
} from './binding.ts';
import { RumikTtsError } from './errors.ts';
import { GenerationLane } from './lane.ts';
import { RumikReply } from './reply.ts';

export const RUMIK_TTS_CAPABILITIES = Object.freeze({
  // μ-law 8 kHz first: Twilio takes it as is. 24 kHz PCM is Silk's native rate; there is no 8 or
  // 16 kHz PCM (https://docs.rumik.ai/audio-formats, retrieved 2026-10-13).
  outputFormats: [MULAW_8K, PCM16_24K],
  // Only English, Hindi and Hinglish are documented for the API (https://docs.rumik.ai/voices);
  // Tamil, Telugu, Bengali and Marathi are UNCONFIRMED and not advertised.
  languages: ['en', 'en-IN', 'hi', 'hi-IN'],
  interim: false,
  wordTimestamps: false,
  turnSignals: [] as const,
  forceEndpoint: false,
  // A second text frame interrupts the first: there is no appending text to a running generation.
  incrementalText: false,
  maxChars: 2000,
});

type OpenInput = Omit<SynthesisInput, 'text'>;

/**
 * Rumik Silk TTS. One instance serves one session: every utterance is a generation on one queue
 * per output format, rendered over a minted socket (or `POST /v1/tts`), one at a time. There is no
 * `open()`: Silk cannot take text incrementally, so the speech output uses `synthesize` and
 * `openReply`.
 */
export class RumikTts implements TextToSpeech {
  readonly capabilities: Omit<typeof RUMIK_TTS_CAPABILITIES, 'maxChars'> & { maxChars: number };
  readonly binding: Readonly<RumikTtsBinding>;
  private readonly lanes = new Map<string, GenerationLane>();
  private requestNumber = 0;
  private disposed = false;

  constructor(
    private readonly net: NetPort,
    private readonly apiKey: string,
    binding: RumikTtsBinding = {},
    private readonly clock: Clock = systemClock,
    private readonly logger?: Logger,
  ) {
    const frozen: Readonly<RumikTtsBinding> = Object.freeze(structuredClone(binding));
    this.binding = frozen;
    this.capabilities = Object.freeze({ ...RUMIK_TTS_CAPABILITIES, maxChars: textLimit(frozen) });
  }

  cacheIdentity(format: AudioFormat, voice?: string) {
    return cacheIdentity(this.binding, format, voice);
  }

  /** Mints and connects the session's socket ahead of the first utterance; never rejects. */
  warm(input: { format: AudioFormat; voice?: string }): Promise<void> {
    const overSocket =
      !this.disposed && this.binding.transport !== 'http' && this.native(input.format);
    if (!overSocket) return Promise.resolve();
    // swallow-ok: warming is an optimisation; the first generation mints again or uses HTTP.
    return this.lane(input.format)
      .warm()
      .catch(() => undefined);
  }

  async *synthesize(input: SynthesisInput): AsyncIterable<Uint8Array> {
    this.begin(input);
    this.checkText(input.text);
    yield* this.queue(input, input.text, input.signal);
  }

  async openReply(input: OpenInput): Promise<TtsReply> {
    this.begin(input);
    return new RumikReply((text, signal, quiet) => {
      this.checkText(text);
      return this.queue(input, text, signal, quiet);
    }, input.signal);
  }

  /** Session end: every queue stops and every socket is sent `{"type":"close"}`. */
  dispose(): void {
    this.disposed = true;
    for (const lane of this.lanes.values()) lane.dispose();
    this.lanes.clear();
  }

  private queue(
    input: OpenInput,
    text: string,
    signal: AbortSignal,
    quiet?: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    if (this.disposed) throw new RumikTtsError('Rumik TTS is disposed', false);
    const spoken = spokenText(this.binding, text);
    return this.lane(input.format).submit({
      spoken,
      ...(input.voice ? { voice: input.voice } : {}),
      requestId: syntheticRequestId('rumik', input.sessionId, ++this.requestNumber),
      characters: billedCharacters(this.binding, spoken),
      onUsage: input.onUsage,
      signal,
      ...(quiet ? { quiet } : {}),
    });
  }

  private lane(format: AudioFormat): GenerationLane {
    const key = audioFormatOf(format)!;
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = new GenerationLane(
        {
          net: this.net,
          apiKey: this.apiKey,
          binding: this.binding,
          clock: this.clock,
          ...(this.logger ? { logger: this.logger } : {}),
        },
        format,
      );
      this.lanes.set(key, lane);
    }
    return lane;
  }

  private begin(input: OpenInput): void {
    if (!this.native(input.format))
      throw new TypeError('Rumik TTS emits only native μ-law 8 kHz or PCM16 24 kHz');
    input.signal.throwIfAborted();
    if (this.disposed) throw new RumikTtsError('Rumik TTS is disposed', false);
  }

  private checkText(text: string): void {
    if (!text.trim() || [...text].length > this.capabilities.maxChars)
      throw new TypeError(`Rumik TTS text must contain 1–${this.capabilities.maxChars} characters`);
  }

  private native(format: AudioFormat): boolean {
    return this.capabilities.outputFormats.some((candidate) => sameFormat(candidate, format));
  }
}
