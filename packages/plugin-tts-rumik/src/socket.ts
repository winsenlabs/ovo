import type { Clock, Logger, NetPort, WebSocketLike } from '@winsendotai/ovo-contracts';
import { openProviderSocket } from '@winsendotai/ovo-plugin-kit';
import { RUMIK_HOST } from './binding.ts';
import { RumikTtsError, frameError, retryableClose } from './errors.ts';

/** What the socket routes to the one generation in flight. */
export interface GenerationSink {
  audio(bytes: Uint8Array): void;
  done(frame: Record<string, unknown>): void;
  cancelled(frame: Record<string, unknown>): void;
  /** `socketAlive` is true for a recoverable error frame: the socket takes the next text frame. */
  failed(error: Error, socketAlive: boolean): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Redeems a minted URL. The token rides in the URL, so no header is sent: the `rk_live_` key
 * never travels on the socket. Rejects on a refused, closed or slow handshake.
 */
export async function connectSocket(
  net: NetPort,
  url: string,
  options: { clock: Pick<Clock, 'setTimeout'>; timeoutMs: number; signal: AbortSignal },
  logger?: Logger,
): Promise<RumikSocket> {
  const socket = await openProviderSocket(net, url, {}, [RUMIK_HOST], options);
  return new RumikSocket(socket, logger);
}

/**
 * One redeemed Silk TTS socket (https://docs.rumik.ai/streaming). It carries many utterances but
 * one generation at a time, so every frame goes to the single attached sink. Any close, error,
 * `{"type":"timeout"}` or fatal error frame leaves it unusable: the lane mints a fresh one for the
 * next generation, because the token it was opened with was single-use.
 */
export class RumikSocket {
  private readonly unsubscribe: (() => void)[];
  private sink?: GenerationSink;
  private failure?: Error;
  /** A cancel lost the race to `done`; a `cancelled` answering it may still arrive. */
  private straggler = false;

  constructor(
    private readonly socket: WebSocketLike,
    private readonly logger?: Logger,
  ) {
    this.unsubscribe = [
      socket.on('message', (raw, binary) => this.message(raw, binary)),
      socket.on('close', (code) =>
        this.fail(new RumikTtsError(`Rumik TTS socket closed (${code})`, retryableClose(code))),
      ),
      socket.on('error', (error) =>
        this.fail(new RumikTtsError(`Rumik TTS socket error: ${error.name}`, true)),
      ),
    ];
  }

  /** Open, and no failure seen: the next generation may use it. */
  get usable(): boolean {
    return this.failure === undefined && this.socket.readyState === 1;
  }

  attach(sink: GenerationSink): void {
    if (this.failure) throw this.failure;
    this.sink = sink;
  }

  detach(sink: GenerationSink): void {
    if (this.sink === sink) this.sink = undefined;
  }

  send(frame: Record<string, unknown>): void {
    if (this.failure) throw this.failure;
    if (this.socket.readyState !== 1) throw new RumikTtsError('Rumik TTS socket is not open', true);
    this.socket.send(JSON.stringify(frame));
  }

  /** Session end: `{"type":"close"}`, then a normal close. A generation in flight fails retryably. */
  close(): void {
    if (this.usable) {
      try {
        this.send({ type: 'close' });
      } catch {
        // swallow-ok: the socket is going away either way; fail() below closes it.
      }
    }
    this.fail(new RumikTtsError('Rumik TTS session closed', true));
  }

  /**
   * The cancelled generation finished (`done`) before Rumik saw the cancel. If Rumik still answers
   * that cancel with `cancelled`, the answer arrives ahead of the next generation's first audio and
   * belongs to nobody, so it is dropped rather than read as the next generation being cancelled.
   */
  expectStraggler(): void {
    this.straggler = true;
  }

  /** Drops the socket without the close frame (a cancel that was never acknowledged). */
  abandon(reason: string): void {
    this.fail(new RumikTtsError(`Rumik TTS socket abandoned: ${reason}`, true));
  }

  private message(raw: string | Uint8Array, binary: boolean): void {
    if (typeof raw !== 'string') {
      this.straggler = false;
      if (raw.byteLength) this.sink?.audio(raw);
      return;
    }
    if (binary) return;
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return this.fail(new RumikTtsError('Rumik TTS sent a malformed text frame', true));
    }
    if (!isRecord(data)) return;
    if (data.error === true || (data.error !== undefined && data.code !== undefined)) {
      const error = frameError(data);
      // "When `recoverable` is true the socket stays open and you can send the next frame."
      if (data.recoverable === true) return this.sink?.failed(error, true);
      return this.fail(error);
    }
    switch (data.type) {
      case 'done':
        this.straggler = false;
        return this.sink?.done(data);
      case 'cancelled':
        if (this.straggler) {
          this.straggler = false;
          return;
        }
        return this.sink?.cancelled(data);
      case 'timeout':
        // Idle timeout; the server-side duration is UNCONFIRMED. The next generation re-mints.
        this.logger?.info('rumik.tts.socket_timeout');
        return this.fail(new RumikTtsError('Rumik TTS socket idle timeout', true));
      default:
      // Anything else (Pipecat's source shows an undocumented `queued`) carries nothing to act on.
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const off of this.unsubscribe.splice(0)) off();
    const sink = this.sink;
    this.sink = undefined;
    sink?.failed(error, false);
    if (this.socket.readyState > 1) return;
    try {
      this.socket.close(1000);
    } catch {
      // swallow-ok: the socket is already gone; the generation was failed above.
    }
  }
}
