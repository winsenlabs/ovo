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
  DEFAULT_MODEL,
  cacheRevision,
  contextOpening,
  multiStreamUrl,
  textLimit,
  voiceOf,
  type ElevenLabsTtsBinding,
} from './binding.ts';
import { MultiContextConnection } from './connection.ts';
import { ElevenLabsContext } from './context.ts';
import { ElevenLabsTtsError } from './errors.ts';
import { HttpIncrementalTts } from './http-context.ts';
import { streamHttp } from './http-stream.ts';
import { ReplayingContext } from './replaying-context.ts';
import type { HttpRender } from './reply-part.ts';
import { ElevenLabsReply } from './reply.ts';

export const ELEVENLABS_TTS_CAPABILITIES = Object.freeze({
  // μ-law 8 kHz first: Twilio takes it as is, with no resample or transcode on the hot path.
  outputFormats: [MULAW_8K, PCM16_8K, PCM16_16K, PCM16_24K],
  languages: ['*'],
  interim: false,
  wordTimestamps: false,
  turnSignals: [] as const,
  forceEndpoint: false,
  incrementalText: true,
  maxChars: 40_000,
});

/** After a failed connect, new utterances use HTTP for this long instead of paying the timeout again. */
const SOCKET_RETRY_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;
/** Without alignment, a reply segment is over once its audio has been quiet this long. */
const REPLY_QUIET_MS = 600;

type OpenInput = Omit<SynthesisInput, 'text'>;

/**
 * ElevenLabs TTS (TTS-1/TTS-2). One instance serves one session: every utterance is a context on
 * one pooled `multi-stream-input` socket per voice and format, opened lazily (or by `warm`) and
 * reopened lazily after the provider closes it. HTTP streaming covers a socket that cannot open.
 */
export class ElevenLabsTts implements TextToSpeech {
  readonly capabilities: Omit<typeof ELEVENLABS_TTS_CAPABILITIES, 'maxChars'> & {
    maxChars: number;
  };
  readonly binding: Readonly<ElevenLabsTtsBinding>;
  /** LAT-5 reply contexts; absent when the binding sets `replyStream: false`. */
  readonly openReply?: (input: OpenInput) => Promise<TtsReply>;
  private readonly pool = new Map<string, MultiContextConnection>();
  private requestNumber = 0;
  private socketDownUntil = Number.NEGATIVE_INFINITY;
  private disposed = false;

  constructor(
    private readonly net: NetPort,
    private readonly apiKey: string,
    binding: ElevenLabsTtsBinding = {},
    private readonly clock: Clock = systemClock,
  ) {
    this.binding = Object.freeze(structuredClone(binding));
    this.capabilities = Object.freeze({
      ...ELEVENLABS_TTS_CAPABILITIES,
      maxChars: textLimit(this.binding),
    });
    if (this.binding.replyStream !== false) this.openReply = (input) => this.reply(input);
  }

  cacheIdentity(format: AudioFormat, voice?: string) {
    return {
      provider: 'elevenlabs',
      model: this.binding.model ?? DEFAULT_MODEL,
      voice: voiceOf(this.binding, voice),
      revision: cacheRevision(this.binding, format),
    };
  }

  /** Opens the session's socket ahead of the first utterance; failures are left to `open`. */
  async warm(input: { format: AudioFormat; voice?: string }): Promise<void> {
    if (this.disposed || this.binding.transport === 'http' || !this.native(input.format)) return;
    try {
      await this.connection(input.format, input.voice).ready;
    } catch {
      // swallow-ok: warming is an optimisation; the first open() reconnects or falls back to HTTP.
    }
  }

  async open(input: OpenInput): Promise<IncrementalTts> {
    const number = this.begin(input);
    const requestId = syntheticRequestId('elevenlabs', input.sessionId, number);
    const socket = await this.socketFor(input);
    if (!socket) return this.overHttp(input, number, requestId);
    const context = (onUsage: OpenInput['onUsage']) => {
      try {
        return new ElevenLabsContext({
          connection: socket.connection,
          contextId: `ovo-${number}`,
          requestId,
          input: { ...input, onUsage },
          opening: contextOpening(this.binding),
          limit: this.capabilities.maxChars,
          clock: this.clock,
          release: socket.release,
        });
      } catch (error) {
        socket.release();
        throw error;
      }
    };
    if (this.binding.httpFallback === false) return context(input.onUsage);
    return new ReplayingContext(context, this.render(input), input.signal, input.onUsage);
  }

  /** LAT-5: one context for a whole reply (see ElevenLabsReply). Unset by `replyStream: false`. */
  private async reply(input: OpenInput): Promise<TtsReply> {
    const number = this.begin(input);
    const socket = await this.socketFor(input);
    return new ElevenLabsReply({
      ...(socket ? { socket } : {}),
      contextId: `ovo-${number}`,
      requestId: syntheticRequestId('elevenlabs', input.sessionId, number),
      input,
      opening: contextOpening(this.binding),
      limit: this.capabilities.maxChars,
      clock: this.clock,
      render: this.render(input),
      replay: this.binding.httpFallback !== false,
      quietMs: REPLY_QUIET_MS,
    });
  }

  async *synthesize(input: SynthesisInput): AsyncIterable<Uint8Array> {
    if (!input.text || [...input.text].length > this.capabilities.maxChars)
      throw new TypeError(
        `ElevenLabs TTS text must contain 1–${this.capabilities.maxChars} characters`,
      );
    // A socket that drops before the first byte is replayed over HTTP inside the context.
    const context = await this.open(input);
    try {
      context.push(input.text);
      context.flush();
      yield* context.audio;
    } finally {
      await context.close();
    }
  }

  /** Closes every pooled socket (session end). */
  dispose(): void {
    this.disposed = true;
    for (const connection of this.pool.values()) connection.close();
    this.pool.clear();
  }

  private connection(format: AudioFormat, voice?: string): MultiContextConnection {
    const url = multiStreamUrl(this.binding, voiceOf(this.binding, voice), format);
    const pooled = this.pool.get(url);
    if (pooled?.usable) return pooled;
    const created = new MultiContextConnection(
      this.net,
      url,
      this.apiKey,
      this.clock,
      this.binding.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    );
    this.pool.set(url, created);
    return created;
  }

  private overHttp(input: OpenInput, number: number, requestId: string): IncrementalTts {
    return new HttpIncrementalTts(
      (request) => streamHttp(this.httpPort(), request, number),
      input,
      requestId,
      this.capabilities.maxChars,
    );
  }

  /** One HTTP stream per call, each with its own request number (and so its own meter id). */
  private render(input: OpenInput): HttpRender {
    return (text, signal, onUsage) =>
      streamHttp(this.httpPort(), { ...input, text, signal, onUsage }, ++this.requestNumber);
  }

  private begin(input: OpenInput): number {
    this.assertNative(input.format);
    input.signal.throwIfAborted();
    if (this.disposed) throw new ElevenLabsTtsError('ElevenLabs TTS is disposed', false);
    return ++this.requestNumber;
  }

  /**
   * The pooled socket with a context slot held, or undefined when this utterance goes over HTTP:
   * `transport: 'http'`, a socket that failed within the last 30 s, or one that fails now.
   */
  private async socketFor(
    input: OpenInput,
  ): Promise<{ connection: MultiContextConnection; release: () => void } | undefined> {
    if (this.binding.transport === 'http' || this.clock.now() < this.socketDownUntil)
      return undefined;
    let connection: MultiContextConnection;
    try {
      connection = this.connection(input.format, input.voice);
      await untilAborted(connection.ready, input.signal);
    } catch (error) {
      if (input.signal.aborted || this.binding.httpFallback === false) throw error;
      this.socketDownUntil = this.clock.now() + SOCKET_RETRY_MS;
      return undefined;
    }
    return { connection, release: await connection.acquire(input.signal) };
  }

  private httpPort() {
    return { net: this.net, apiKey: this.apiKey, binding: this.binding, clock: this.clock };
  }

  private native(format: AudioFormat): boolean {
    return this.capabilities.outputFormats.some((candidate) => sameFormat(candidate, format));
  }

  private assertNative(format: AudioFormat): void {
    if (!this.native(format))
      throw new TypeError('ElevenLabs TTS emits only native μ-law 8 kHz or PCM16 8/16/24 kHz');
  }
}

function untilAborted(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError(signal));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
