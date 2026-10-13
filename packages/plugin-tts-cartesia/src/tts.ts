import {
  MULAW_8K,
  PCM16_16K,
  PCM16_24K,
  PCM16_8K,
  sameFormat,
  type AudioFormat,
  type Clock,
  type IncrementalTts,
  type NetPort,
  type SynthesisInput,
  type TextToSpeech,
  type TtsReply,
} from '@winsendotai/ovo-contracts';
import { abortError, syntheticRequestId, systemClock } from '@winsendotai/ovo-plugin-kit';
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_MAX_CONTEXTS,
  DEFAULT_MODEL,
  SONIC_LANGUAGES,
  cacheRevision,
  requestFields,
  socketUrl,
  voiceOf,
  type CartesiaTtsBinding,
} from './binding.ts';
import { CartesiaSocket } from './connection.ts';
import { CartesiaTtsError } from './errors.ts';
import { CartesiaReply } from './reply.ts';
import { ContextSlots, RETRY_PAUSES_MS, pause } from './slots.ts';
import { CartesiaStream, type OpenInput } from './stream.ts';

export const CARTESIA_TTS_CAPABILITIES = Object.freeze({
  // μ-law 8 kHz first: raw `pcm_mulaw` goes to the carrier with no resample or transcode.
  outputFormats: [MULAW_8K, PCM16_8K, PCM16_16K, PCM16_24K],
  languages: SONIC_LANGUAGES,
  interim: false,
  wordTimestamps: false,
  turnSignals: [] as const,
  forceEndpoint: false,
  incrementalText: true,
  // UNCONFIRMED: the socket reference states no per-context character limit; a conservative cap.
  maxChars: 5_000,
});

/**
 * Cartesia Sonic 3.6 over `wss://api.cartesia.ai/tts/websocket`. One instance serves one session
 * with one pooled socket: unlike ElevenLabs, voice and format travel in each request, so a single
 * socket serves every format. Every utterance is a context on it, at most `maxContexts` at once.
 */
export class CartesiaTts implements TextToSpeech {
  readonly capabilities = CARTESIA_TTS_CAPABILITIES;
  readonly binding: Readonly<CartesiaTtsBinding>;
  private readonly slots: ContextSlots;
  private socket?: CartesiaSocket;
  private requests = 0;
  private disposed = false;

  constructor(
    private readonly net: NetPort,
    private readonly apiKey: string,
    binding: CartesiaTtsBinding = {},
    private readonly clock: Clock = systemClock,
  ) {
    this.binding = Object.freeze(structuredClone(binding));
    this.slots = new ContextSlots(this.binding.maxContexts ?? DEFAULT_MAX_CONTEXTS);
  }

  cacheIdentity(format: AudioFormat, voice?: string) {
    const resolved = voiceOf(this.binding, voice);
    return {
      provider: 'cartesia',
      model: this.binding.model ?? DEFAULT_MODEL,
      voice: resolved,
      revision: cacheRevision(this.binding, format, resolved),
    };
  }

  /** Opens the session's socket ahead of the first utterance. Never rejects. */
  async warm(input: { format: AudioFormat; voice?: string }): Promise<void> {
    if (this.disposed || !this.native(input.format)) return;
    try {
      await this.connect(new AbortController().signal);
    } catch {
      // swallow-ok: warming is an optimisation; the first open() connects (and retries) itself.
    }
  }

  async open(input: OpenInput): Promise<IncrementalTts> {
    const { number, fields } = this.begin(input);
    const release = await this.slots.acquire(input.signal);
    try {
      return await CartesiaStream.open({
        contextId: `ovo-${number}`,
        requestId: syntheticRequestId('cartesia', input.sessionId, number),
        input,
        fields,
        limit: this.capabilities.maxChars,
        clock: this.clock,
        connect: (signal) => this.connect(signal),
        release,
      });
    } catch (error) {
      release();
      throw error;
    }
  }

  /** LAT-5: one context per agent reply, segments flushed in order (see CartesiaReply). */
  async openReply(input: OpenInput): Promise<TtsReply> {
    const { number, fields } = this.begin(input);
    const release = await this.slots.acquire(input.signal);
    try {
      return new CartesiaReply({
        contextId: `ovo-${number}`,
        requestId: syntheticRequestId('cartesia', input.sessionId, number),
        input,
        fields,
        limit: this.capabilities.maxChars,
        clock: this.clock,
        socket: await this.connectRetrying(input.signal),
        connect: (signal) => this.connect(signal),
        release,
      });
    } catch (error) {
      release();
      throw error;
    }
  }

  async *synthesize(input: SynthesisInput): AsyncIterable<Uint8Array> {
    const size = [...input.text].length;
    if (!size || size > this.capabilities.maxChars)
      throw new TypeError(
        `Cartesia TTS text must contain 1–${this.capabilities.maxChars} characters`,
      );
    const stream = await this.open(input);
    try {
      stream.push(input.text);
      stream.flush();
      yield* stream.audio;
    } finally {
      await stream.close();
    }
  }

  /** Session end: the pooled socket closes and any open context fails. */
  dispose(): void {
    this.disposed = true;
    this.socket?.close();
    this.socket = undefined;
  }

  /**
   * The pooled socket once open. A socket that failed or idled out (the provider closes idle
   * sockets after 5 minutes) is replaced lazily here, on the next utterance that needs one.
   */
  private async connect(signal: AbortSignal): Promise<CartesiaSocket> {
    if (this.disposed) throw new CartesiaTtsError('Cartesia TTS is disposed', false);
    let socket = this.socket;
    if (!socket?.usable) {
      socket = new CartesiaSocket(
        this.net,
        socketUrl(this.binding),
        this.apiKey,
        this.clock,
        this.binding.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      );
      this.socket = socket;
    }
    await untilAborted(socket.ready, signal);
    return socket;
  }

  /** `connect`, paused and retried on a retryable refusal (429, 5xx, a dropped handshake). */
  private async connectRetrying(signal: AbortSignal): Promise<CartesiaSocket> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.connect(signal);
      } catch (error) {
        const retryable = error instanceof CartesiaTtsError && error.retryable;
        if (!retryable || attempt >= RETRY_PAUSES_MS.length) throw error;
        await pause(this.clock, RETRY_PAUSES_MS[attempt]!, signal);
      }
    }
  }

  private begin(input: OpenInput): { number: number; fields: Record<string, unknown> } {
    if (!this.native(input.format))
      throw new TypeError('Cartesia TTS emits only native μ-law 8 kHz or PCM16 8/16/24 kHz');
    input.signal.throwIfAborted();
    if (this.disposed) throw new CartesiaTtsError('Cartesia TTS is disposed', false);
    // Built before the slot is taken, so an unsupported language or missing voice fails at once.
    const fields = requestFields(this.binding, input);
    return { number: ++this.requests, fields };
  }

  private native(format: AudioFormat): boolean {
    return this.capabilities.outputFormats.some((candidate) => sameFormat(candidate, format));
  }
}

/** `promise`, or an AbortError as soon as `signal` aborts (the socket itself keeps connecting). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
