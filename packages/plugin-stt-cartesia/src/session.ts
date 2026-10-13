import {
  bytesPerSecond,
  type Clock,
  type SpeechToText,
  type SttSession,
  type WebSocketLike,
} from '@winsendotai/ovo-contracts';
import {
  decimal,
  syntheticRequestId,
  usageOnce,
  type UsageOnce,
} from '@winsendotai/ovo-plugin-kit';
import { BacklogPacer, Framer, SilenceKeeper, type UplinkItem } from './pacing.ts';
import {
  CartesiaSttError,
  closeFailure,
  parseEvent,
  transportFailure,
  eventError,
} from './wire.ts';

export type Start = Parameters<SpeechToText['start']>[0];

/**
 * The runtime allows one installed STT definition per provider (`runtime/src/installed.ts`, which
 * `registry.resolve(kind, provider)` relies on), so the Manual definition is its own provider.
 */
export type SttProvider = 'cartesia' | 'cartesia-manual';

/** Audio goes out in 100 ms binary frames, the size both references recommend. */
export const FRAME_MS = 100;
/** The shortest frame a flush sends; matches `frameMs.min`. */
export const MIN_FRAME_MS = 20;
/** How long a graceful finish waits for the provider's last events. */
export const FINISH_TIMEOUT_MS = 3_000;

export interface SessionOptions {
  clock: Clock;
  /** The definition's manifest provider: its usage must price against that provider's cards. */
  provider: SttProvider;
  /** Numbers this connection's synthetic request id when the provider sends none. */
  attempt: number;
  backlogMaxRate: number;
}

/**
 * What both Ink endpoints share: binary 100 ms frames through the backlog pacer, the silence keeper,
 * the provider's error and close handling, and usage exactly once across finish, cancel and failure.
 * The audio meter is the bytes sent, silence included, over the format's byte rate: Ink bills
 * silence too ("Silence is also included", https://docs.cartesia.ai/pricing.md).
 */
export abstract class CartesiaSttSession implements SttSession {
  readonly ready: Promise<void>;
  protected state: 'connecting' | 'active' | 'finishing' | 'ended' = 'connecting';
  protected requestId?: string;
  private readonly opened = Promise.withResolvers<void>();
  private readonly closed = Promise.withResolvers<void>();
  private readonly framer: Framer;
  private readonly pacer: BacklogPacer;
  private keeper?: SilenceKeeper;
  private readonly usage: UsageOnce;
  private readonly startedAt: number;
  private readonly listeners: (() => void)[];
  private failure?: Error;
  private sentBytes = 0;
  private stopDeadline?: () => void;

  constructor(
    protected readonly socket: WebSocketLike,
    protected readonly input: Start,
    protected readonly options: SessionOptions,
  ) {
    this.ready = this.opened.promise;
    // swallow-ok: start() and finish() await these; the handlers only prevent unhandled rejections.
    void this.ready.catch(() => undefined);
    void this.closed.promise.catch(() => undefined);
    this.startedAt = options.clock.now();
    this.usage = usageOnce(input.onUsage);
    this.framer = new Framer(input.format, FRAME_MS, MIN_FRAME_MS);
    this.pacer = new BacklogPacer(
      options.clock,
      input.format,
      (item) => this.transmit(item),
      options.backlogMaxRate,
      FRAME_MS,
    );
    const abort = () => this.fail(new DOMException('Cartesia STT session aborted', 'AbortError'));
    input.signal.addEventListener('abort', abort, { once: true });
    this.listeners = [
      () => input.signal.removeEventListener('abort', abort),
      socket.on('open', () => this.opening()),
      socket.on('message', (data, binary) => this.receive(data, binary)),
      socket.on('close', (code, reason) =>
        this.state === 'finishing' ? this.endGracefully() : this.fail(closeFailure(code, reason)),
      ),
      socket.on('error', (error) => this.fail(transportFailure(error))),
    ];
  }

  async write(frame: Uint8Array, signal?: AbortSignal): Promise<void> {
    this.writable(signal);
    if (!frame.byteLength) throw new TypeError('Cartesia STT audio frame is empty');
    this.audio(this.framer.push(frame));
    this.keeper?.touch();
    this.wrote();
  }

  async finish(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason;
    if (this.state === 'active') {
      this.state = 'finishing';
      this.keeper?.stop();
      const rest = this.framer.rest();
      if (rest) this.pacer.push({ audio: rest });
      void this.pacer.drained().then(() => {
        if (this.state !== 'finishing') return;
        this.stopDeadline = this.options.clock.setTimeout(
          () => this.endGracefully(),
          FINISH_TIMEOUT_MS,
        );
        this.drainProvider();
      });
    }
    const abort = () => this.fail(new DOMException('Cartesia STT finish aborted', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await this.closed.promise;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  async cancel(_reason: string): Promise<void> {
    this.end();
  }

  /** Fails a session whose handshake did not finish in time. */
  abandon(error: Error): void {
    this.fail(error);
  }

  /** Tells the provider the audio is over and waits for its last events (endpoint-specific). */
  protected abstract drainProvider(): void;
  /** One provider event; `error` events are handled before this is called. */
  protected abstract handle(event: Record<string, unknown>): void;
  /** Real caller audio was written (not keeper silence). */
  protected wrote(): void {}
  /** A graceful end is near: words the provider sent but never closed are the caller's (final). */
  protected flushPending(): void {}

  /** Queues a text command behind the audio written so far, with that audio flushed first. */
  protected command(text: string): void {
    const rest = this.framer.rest();
    if (rest) this.pacer.push({ audio: rest });
    this.pacer.push({ text });
  }

  /** Sends a text frame now, ahead of any queued audio. */
  protected sendNow(text: string): void {
    this.socket.send(text);
  }

  protected writable(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    this.input.signal.throwIfAborted();
    if (this.failure) throw this.failure;
    if (this.state !== 'active') throw new Error('Cartesia STT session is no longer writable');
    if (this.socket.readyState !== 1) {
      const error = new CartesiaSttError('Cartesia STT socket closing', 1006, true);
      this.fail(error);
      throw error;
    }
  }

  /** `finish` is over (the provider closed, or the deadline passed): pending words, then end. */
  protected endGracefully(): void {
    if (this.state === 'ended') return;
    this.flushPending();
    this.end();
  }

  /** The graceful or cancelled end: usage once, then the socket closes normally. */
  protected end(): void {
    if (this.state === 'ended') return;
    const connecting = this.state === 'connecting';
    this.settle();
    if (connecting) this.opened.reject(new DOMException('Cartesia STT cancelled', 'AbortError'));
    this.closed.resolve();
    this.closeSocket(1000);
  }

  protected fail(error: Error): void {
    if (this.state === 'ended') return;
    this.failure = error;
    this.settle();
    this.opened.reject(error);
    this.closed.reject(error);
    this.closeSocket();
  }

  private opening(): void {
    if (this.state !== 'connecting') return;
    this.state = 'active';
    // Silence only fills a real gap: while paced backlog is still queued the provider is fed.
    this.keeper = new SilenceKeeper(this.options.clock, (ms) => {
      if (!this.pacer.queuedMs) this.audio(this.framer.silence(ms));
    });
    this.opened.resolve();
  }

  private audio(frames: readonly Uint8Array[]): void {
    for (const frame of frames) this.pacer.push({ audio: frame });
  }

  private transmit(item: UplinkItem): void {
    if (this.state === 'ended' || this.socket.readyState !== 1) return;
    try {
      if ('audio' in item) {
        this.socket.send(item.audio);
        this.sentBytes += item.audio.byteLength;
      } else this.socket.send(item.text);
    } catch (error) {
      this.fail(new CartesiaSttError(`Cartesia STT send failed: ${String(error)}`, 1006, true));
    }
  }

  private receive(data: string | Uint8Array, binary: boolean): void {
    if (this.state === 'ended') return;
    const event = parseEvent(data, binary);
    if (!event)
      return this.fail(
        new CartesiaSttError('Cartesia STT sent a malformed event', 'protocol', false),
      );
    if (typeof event.request_id === 'string') this.requestId ??= event.request_id;
    if (event.type === 'error') return this.fail(eventError(event));
    this.handle(event);
  }

  private settle(): void {
    this.state = 'ended';
    this.stopDeadline?.();
    this.keeper?.stop();
    this.pacer.stop();
    for (const off of this.listeners.splice(0)) off();
    this.usage.emit({
      provider: this.options.provider,
      operation: 'stt',
      unit: 'audio_seconds',
      quantity: decimal(this.sentBytes / bytesPerSecond(this.input.format)),
      state: 'estimated',
      requestId:
        this.requestId ??
        syntheticRequestId(this.options.provider, this.input.sessionId, this.options.attempt),
      elapsedMs: Math.max(0, this.options.clock.now() - this.startedAt),
    });
  }

  private closeSocket(code?: number): void {
    try {
      this.socket.close(code);
    } catch {
      // swallow-ok: a socket still connecting may refuse a close; it is discarded either way.
    }
  }
}
