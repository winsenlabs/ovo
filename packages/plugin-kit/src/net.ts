import WebSocket, { type ClientOptions, type RawData } from 'ws';
import type { NetPort, WebSocketLike } from '@winsendotai/ovo-contracts';

export interface NodeNetOptions {
  /** Defaults to the global fetch. Tests inject a loopback-trusting fetch. */
  fetch?: typeof globalThis.fetch;
  /** Extra `ws` client options, e.g. `{ca}` to trust a loopback test certificate. */
  websocketOptions?: Omit<ClientOptions, 'headers'>;
  /** Largest inbound WebSocket message; defaults to 16 MiB. */
  maxPayload?: number;
}

export class NetProtocolError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'NetProtocolError';
  }
}

function secureUrl(raw: string, protocol: 'https:' | 'wss:'): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new NetProtocolError('NetPort requires an absolute URL');
  }
  if (url.protocol !== protocol)
    throw new NetProtocolError(`NetPort accepts only https: and wss: URLs (got ${url.protocol})`);
  if (url.username || url.password)
    throw new NetProtocolError('NetPort URLs cannot carry credentials');
  return url;
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** Adapts a `ws` client to `WebSocketLike`; `on` returns an unsubscribe function. */
export function wrapWebSocket(socket: WebSocket): WebSocketLike {
  // An 'error' with no listener would crash the process; subscribers still receive it.
  socket.on('error', () => undefined);
  const subscribe = (event: string, listener: (...args: never[]) => void) => {
    socket.on(event, listener as (...args: unknown[]) => void);
    return () => {
      socket.off(event, listener as (...args: unknown[]) => void);
    };
  };
  return {
    get readyState() {
      return socket.readyState as 0 | 1 | 2 | 3;
    },
    send(data) {
      socket.send(data);
    },
    close(code, reason) {
      socket.close(code, reason);
    },
    on(event: 'open' | 'message' | 'close' | 'error', fn: (...args: never[]) => void) {
      if (event === 'message') {
        const listener = (data: RawData, isBinary: boolean) =>
          (fn as (data: string | Uint8Array, isBinary: boolean) => void)(
            isBinary ? toBytes(data) : Buffer.from(toBytes(data)).toString('utf8'),
            isBinary,
          );
        return subscribe('message', listener);
      }
      if (event === 'close') {
        const listener = (code: number, reason: Buffer) =>
          (fn as (code: number, reason: string) => void)(code, reason.toString('utf8'));
        return subscribe('close', listener);
      }
      return subscribe(event, fn);
    },
  } as WebSocketLike;
}

/**
 * The production `ovo.net`: global fetch and `ws`, https:/wss: only. Each call takes its own
 * AbortSignal (fetch `init.signal`); redirects are never followed silently.
 */
export function createNodeNet(options: NodeNetOptions = {}): NetPort {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  return {
    fetch(url, init = {}) {
      try {
        secureUrl(url, 'https:');
      } catch (error) {
        return Promise.reject(error);
      }
      init.signal?.throwIfAborted();
      return fetchImpl(url, {
        ...init,
        redirect: init.redirect === 'manual' ? 'manual' : 'error',
      });
    },
    websocket(url, opts = {}) {
      secureUrl(url, 'wss:');
      const socket = new WebSocket(url, opts.protocols ?? [], {
        ...options.websocketOptions,
        headers: opts.headers ?? {},
        perMessageDeflate: false,
        followRedirects: false,
        maxPayload: options.maxPayload ?? 16 * 1024 * 1024,
      });
      return wrapWebSocket(socket);
    },
  };
}
