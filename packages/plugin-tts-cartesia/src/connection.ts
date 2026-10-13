import type { Clock, NetPort, WebSocketLike } from '@winsendotai/ovo-contracts';
import { decodeBase64 } from '@winsendotai/ovo-plugin-kit';
import { CartesiaTtsError, closeError, eventError, transportError } from './errors.ts';

/** What the socket routes to one context id. */
export interface ContextSink {
  chunk(audio: Uint8Array): void;
  /** `flush_done`: every chunk of the inputs before that flush has been sent [doc]. */
  flushed(flushId: number | undefined): void;
  done(): void;
  failed(error: CartesiaTtsError): void;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * One `/tts/websocket` connection shared by every context of a session
 * (https://docs.cartesia.ai/api-reference/tts/websocket.md, retrieved 2026-10-13). Server
 * messages are routed by `context_id`. A message for an id nobody holds is dropped: that is how a
 * cancelled context's late chunks die, since `cancel` "will only halt requests that have not begun
 * generating" (https://docs.cartesia.ai/use-the-api/tts-websocket/contexts.md). A socket failure
 * fails every context and leaves the connection unusable; the next utterance opens a new one,
 * which is also how the provider's 5-minute idle close is absorbed.
 */
export class CartesiaSocket {
  readonly ready: Promise<void>;
  private readonly opened = Promise.withResolvers<void>();
  private readonly socket: WebSocketLike;
  private readonly sinks = new Map<string, ContextSink>();
  private readonly listeners: (() => void)[];
  private stopConnectTimer: () => void;
  private failure?: CartesiaTtsError;

  constructor(
    net: NetPort,
    url: string,
    apiKey: string,
    clock: Pick<Clock, 'setTimeout'>,
    connectTimeoutMs: number,
  ) {
    this.ready = this.opened.promise;
    // swallow-ok: whoever awaits `ready` sees the failure; this only avoids an unhandled rejection.
    void this.ready.catch(() => undefined);
    this.socket = net.websocket(url, { headers: { 'X-API-Key': apiKey } });
    this.listeners = [
      this.socket.on('open', () => {
        this.stopConnectTimer();
        this.opened.resolve();
      }),
      this.socket.on('message', (data, binary) => this.receive(data, binary)),
      this.socket.on('close', (code, reason) => this.fail(closeError(code, reason))),
      this.socket.on('error', (error) => this.fail(transportError(error))),
    ];
    this.stopConnectTimer = clock.setTimeout(() => {
      if (this.socket.readyState === 0)
        this.fail(new CartesiaTtsError('Cartesia TTS connect timed out', true));
    }, connectTimeoutMs);
  }

  /** Open, or still opening, and not failed. */
  get usable(): boolean {
    return !this.failure && this.socket.readyState <= 1;
  }

  attach(contextId: string, sink: ContextSink): void {
    if (this.failure) throw this.failure;
    this.sinks.set(contextId, sink);
  }

  detach(contextId: string, sink?: ContextSink): void {
    if (!sink || this.sinks.get(contextId) === sink) this.sinks.delete(contextId);
  }

  send(frame: Record<string, unknown>): void {
    if (this.failure) throw this.failure;
    if (this.socket.readyState !== 1)
      throw new CartesiaTtsError('Cartesia TTS socket is not open', true);
    this.socket.send(JSON.stringify(frame));
  }

  /** Session end: the socket closes normally and open contexts fail as retryable. */
  close(): void {
    this.fail(new CartesiaTtsError('Cartesia TTS session closed', true), 1000);
  }

  private receive(data: string | Uint8Array, binary: boolean): void {
    let event: unknown;
    try {
      event = binary ? undefined : JSON.parse(String(data));
    } catch {
      event = undefined;
    }
    if (!isObject(event))
      return this.fail(new CartesiaTtsError('Cartesia TTS sent a malformed message', false));
    const id = typeof event.context_id === 'string' ? event.context_id : undefined;
    const sink = id === undefined ? undefined : this.sinks.get(id);
    if (event.type === 'error') {
      if (sink) return sink.failed(eventError(event));
      // An error naming a context we let go (barge-in) concerns no one; one naming none is ours.
      return id === undefined ? this.fail(eventError(event)) : undefined;
    }
    if (!sink) return;
    if (event.type === 'chunk' && typeof event.data === 'string') {
      let audio: Uint8Array;
      try {
        audio = decodeBase64(event.data);
      } catch {
        return sink.failed(new CartesiaTtsError('Cartesia TTS sent invalid base64', false));
      }
      if (audio.byteLength) sink.chunk(audio);
    } else if (event.type === 'flush_done') {
      sink.flushed(typeof event.flush_id === 'number' ? event.flush_id : undefined);
    } else if (event.type === 'done') sink.done();
    // `timestamps` and `phoneme_timestamps` are not requested; anything else is tolerated.
  }

  private fail(error: CartesiaTtsError, code?: number): void {
    if (this.failure) return;
    this.failure = error;
    this.stopConnectTimer();
    this.opened.reject(error);
    for (const off of this.listeners.splice(0)) off();
    const sinks = [...this.sinks.values()];
    this.sinks.clear();
    for (const sink of sinks) sink.failed(error);
    if (this.socket.readyState > 1) return;
    try {
      this.socket.close(code);
    } catch {
      // swallow-ok: a socket that refuses the close is already gone; its contexts have failed.
    }
  }
}
