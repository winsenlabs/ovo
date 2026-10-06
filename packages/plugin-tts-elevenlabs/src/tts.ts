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
  type UsageMeter,
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
    this.assertNative(input.format);
    input.signal.throwIfAborted();
    if (this.disposed) throw new ElevenLabsTtsError('ElevenLabs TTS is disposed', false);
    const number = ++this.requestNumber;
    const requestId = syntheticRequestId('elevenlabs', input.sessionId, number);
    if (this.binding.transport === 'http' || this.clock.now() < this.socketDownUntil)
      return this.overHttp(input, number, requestId);
    let connection: MultiContextConnection;
    try {
      connection = this.connection(input.format, input.voice);
      await untilAborted(connection.ready, input.signal);
    } catch (error) {
      if (input.signal.aborted || this.binding.httpFallback === false) throw error;
      this.socketDownUntil = this.clock.now() + SOCKET_RETRY_MS;
      return this.overHttp(input, number, requestId);
    }
    const release = await connection.acquire(input.signal);
    try {
      return new ElevenLabsContext({
        connection,
        contextId: `ovo-${number}`,
        requestId,
        input,
        opening: contextOpening(this.binding),
        limit: this.capabilities.maxChars,
        clock: this.clock,
        release,
      });
    } catch (error) {
      release();
      throw error;
    }
  }

  async *synthesize(input: SynthesisInput): AsyncIterable<Uint8Array> {
    this.assertNative(input.format);
    if (!input.text || [...input.text].length > this.capabilities.maxChars)
      throw new TypeError(
        `ElevenLabs TTS text must contain 1–${this.capabilities.maxChars} characters`,
      );
    input.signal.throwIfAborted();
    let received = false;
    let overSocket = true;
    let retry = false;
    // The first attempt's meter is held until we know whether HTTP retries it, so one synthesis
    // emits exactly one meter: a dropped socket's estimate is replaced by the retry's.
    const held: UsageMeter[] = [];
    try {
      const context = await this.open({ ...input, onUsage: (meter) => held.push(meter) });
      overSocket = context instanceof ElevenLabsContext;
      try {
        context.push(input.text);
        context.flush();
        for await (const chunk of context.audio) {
          received = true;
          yield chunk;
        }
      } finally {
        await context.close();
      }
    } catch (error) {
      // A socket that dropped before any audio is retried once over HTTP; anything after the
      // first byte, a cancel, a refusal (bad key, quota) or an HTTP failure is the caller's.
      retry =
        overSocket &&
        !received &&
        !input.signal.aborted &&
        this.binding.httpFallback !== false &&
        error instanceof ElevenLabsTtsError &&
        error.retryable;
      if (!retry) throw error;
    } finally {
      if (!retry) for (const meter of held) input.onUsage(meter);
    }
    if (retry) yield* streamHttp(this.httpPort(), input, ++this.requestNumber);
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
