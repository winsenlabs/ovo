import type { Clock, NetPort, WebSocketLike } from '@winsendotai/ovo-contracts';
import { abortError, decodeBase64 } from '@winsendotai/ovo-plugin-kit';
import { ElevenLabsTtsError, retryableClose } from './errors.ts';

/**
 * Character timings of one audio frame, relative to that frame's first sample. The reference lists
 * `alignment` as optional on `AudioOutputMulti`; Pipecat's production plugin reads it on the
 * multi-context socket without asking for `sync_alignment` (PIPECAT in testing.ts, 2026-10-06).
 */
export interface Alignment {
  chars: readonly string[];
  charStartTimesMs: readonly number[];
}

/** What the pooled socket routes to one context. */
export interface ContextSink {
  onAudio(bytes: Uint8Array, alignment?: Alignment): void;
  onFinal(): void;
  onError(error: Error): void;
}

/** "Each connection is limited to 5 concurrent contexts" (multi-context guide, 2026-10-06). */
export const MAX_CONTEXTS = 5;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** A well-formed alignment, or undefined (absent, null, or a shape we do not recognise). */
function readAlignment(value: unknown): Alignment | undefined {
  if (!isRecord(value)) return undefined;
  const { chars, charStartTimesMs } = value;
  if (!Array.isArray(chars) || !Array.isArray(charStartTimesMs)) return undefined;
  if (chars.length !== charStartTimesMs.length) return undefined;
  if (!chars.every((char) => typeof char === 'string')) return undefined;
  if (!charStartTimesMs.every((ms) => typeof ms === 'number' && Number.isFinite(ms) && ms >= 0))
    return undefined;
  return { chars: chars as string[], charStartTimesMs: charStartTimesMs as number[] };
}

/**
 * One `multi-stream-input` socket shared by every context of a session (TTS-2). Contexts are
 * routed by `contextId`; a context that ends (final, barge-in, error) never touches the others.
 * Any socket failure fails every open context and leaves this connection unusable, so the pool
 * opens a fresh one on the next `open()`.
 */
export class MultiContextConnection {
  readonly ready: Promise<void>;
  private readonly gate = Promise.withResolvers<void>();
  private readonly socket: WebSocketLike;
  private readonly sinks = new Map<string, ContextSink>();
  private readonly waiting: { grant: () => void; refuse: (error: Error) => void }[] = [];
  private readonly offs: (() => void)[] = [];
  private cancelConnectTimer?: () => void;
  private active = 0;
  private failure?: Error;

  constructor(
    net: NetPort,
    url: string,
    apiKey: string,
    clock: Pick<Clock, 'setTimeout'>,
    connectTimeoutMs: number,
  ) {
    this.ready = this.gate.promise;
    void this.ready.catch(() => undefined);
    this.socket = net.websocket(url, { headers: { 'xi-api-key': apiKey } });
    this.offs.push(
      this.socket.on('open', () => {
        this.cancelConnectTimer?.();
        this.gate.resolve();
      }),
      this.socket.on('message', (raw, binary) => this.message(raw, binary)),
      this.socket.on('close', (code, reason) =>
        this.fail(
          new ElevenLabsTtsError(
            `ElevenLabs TTS socket closed (${code})${reason ? `: ${reason}` : ''}`,
            retryableClose(code),
            code,
          ),
        ),
      ),
      this.socket.on('error', (error) =>
        this.fail(new ElevenLabsTtsError(`ElevenLabs TTS socket error: ${error.message}`, true)),
      ),
    );
    this.cancelConnectTimer = clock.setTimeout(() => {
      if (this.socket.readyState === 0)
        this.fail(new ElevenLabsTtsError('ElevenLabs TTS socket connect timed out', true));
    }, connectTimeoutMs);
  }

  /** Still open or still connecting: a new context may be placed on it. */
  get usable(): boolean {
    return !this.failure && this.socket.readyState <= 1;
  }

  /** Waits (FIFO) for one of the five context slots; the returned release is idempotent. */
  async acquire(signal: AbortSignal): Promise<() => void> {
    if (this.failure) throw this.failure;
    signal.throwIfAborted();
    if (this.active >= MAX_CONTEXTS)
      await new Promise<void>((grant, refuse) => {
        const entry = { grant, refuse };
        const abort = () => {
          const at = this.waiting.indexOf(entry);
          if (at >= 0) this.waiting.splice(at, 1);
          refuse(abortError(signal));
        };
        signal.addEventListener('abort', abort, { once: true });
        entry.grant = () => {
          signal.removeEventListener('abort', abort);
          grant();
        };
        this.waiting.push(entry);
      });
    else this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next.grant();
      else this.active -= 1;
    };
  }

  register(contextId: string, sink: ContextSink): void {
    if (this.failure) throw this.failure;
    this.sinks.set(contextId, sink);
  }

  unregister(contextId: string): void {
    this.sinks.delete(contextId);
  }

  send(frame: Record<string, unknown>): void {
    if (this.failure) throw this.failure;
    if (this.socket.readyState !== 1)
      throw new ElevenLabsTtsError('ElevenLabs TTS socket is not open', true);
    this.socket.send(JSON.stringify(frame));
  }

  /** Ends the socket for good (session end). Open contexts fail as retryable closes. */
  close(): void {
    this.fail(new ElevenLabsTtsError('ElevenLabs TTS session closed', true), 1000);
  }

  private message(raw: string | Uint8Array, binary: boolean): void {
    let data: unknown;
    try {
      if (binary) throw new Error('binary');
      data = JSON.parse(String(raw));
    } catch {
      return this.fail(new ElevenLabsTtsError('ElevenLabs TTS sent a malformed message', false));
    }
    if (!isRecord(data)) return;
    const id = data.contextId ?? data.context_id;
    const sink = typeof id === 'string' ? this.sinks.get(id) : undefined;
    if (data.error !== undefined && data.error !== null) {
      const detail = String(data.message ?? data.error);
      const error = new ElevenLabsTtsError(`ElevenLabs TTS error: ${detail}`, false);
      if (sink) return sink.onError(error);
      // An error for a context that already ended (closed on barge-in) is no longer anyone's.
      return typeof id === 'string' ? undefined : this.fail(error);
    }
    // Audio for a closed context still drains from the server after close_context; drop it.
    if (!sink) return;
    if (typeof data.audio === 'string' && data.audio) {
      let bytes: Uint8Array;
      try {
        bytes = decodeBase64(data.audio);
      } catch {
        return sink.onError(new ElevenLabsTtsError('ElevenLabs TTS sent invalid base64', false));
      }
      sink.onAudio(bytes, readAlignment(data.alignment));
    }
    // The API reference spells it `isFinal`; the multi-context cookbook reads `is_final`.
    if (data.isFinal === true || data.is_final === true) sink.onFinal();
  }

  private fail(error: Error, code?: number): void {
    if (this.failure) return;
    this.failure = error;
    this.cancelConnectTimer?.();
    this.gate.reject(error);
    for (const off of this.offs.splice(0)) off();
    const sinks = [...this.sinks.values()];
    this.sinks.clear();
    for (const sink of sinks) sink.onError(error);
    for (const entry of this.waiting.splice(0)) entry.refuse(error);
    if (this.socket.readyState <= 1) {
      try {
        this.socket.close(code);
      } catch {
        // swallow-ok: the socket is already gone; every context has been failed above.
      }
    }
  }
}
