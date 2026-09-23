import { fetch as undiciFetch } from 'undici';
import WebSocket, { type ClientOptions, type RawData } from 'ws';
import type { NetPort, WebSocketLike } from '@winsendotai/ovo-contracts';
import {
  PinnedAgents,
  createGuardedConnector,
  type AddressPolicy,
  type TlsTrustOptions,
} from './net-pinning.ts';
import {
  assertPublicHost,
  type HostLookup,
  type PublicHostOptions,
  type ResolvedAddress,
} from './ssrf.ts';

export type { TlsTrustOptions } from './net-pinning.ts';

export interface NodeNetOptions {
  /**
   * Defaults to undici's fetch, which is the only one that takes the pinned dispatcher: the global
   * fetch rejects a dispatcher built here. An injected fetch owns its transport and is not pinned,
   * but its destination is still judged before the call.
   */
  fetch?: typeof globalThis.fetch;
  /** Extra `ws` client options, e.g. `{ca}` to trust a loopback test certificate. */
  websocketOptions?: Omit<ClientOptions, 'headers'>;
  /** TLS trust for both transports; defaults to the `ca`/`rejectUnauthorized` of `websocketOptions`. */
  tls?: TlsTrustOptions;
  /** Largest inbound WebSocket message; defaults to 16 MiB. */
  maxPayload?: number;
  /**
   * Resolves a hostname before anything is opened, so a private DNS answer is refused before a
   * packet is sent and the connection is pinned to the addresses that were validated (#24). A
   * composition without one still cannot reach a private peer, but only learns it after connecting.
   */
  lookup?: HostLookup;
  /**
   * TEST ONLY. Exact addresses this port may reach although they are not public, so a test can
   * drive a loopback server. Nothing derives it from configuration or the environment: a caller
   * has to write the addresses out, which no production composition does.
   */
  allowedPrivateAddresses?: readonly string[];
}

/** `createNodeNet`'s port. `close()` releases the pooled connections it opened. */
export interface NodeNet extends NetPort {
  close(): Promise<void>;
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

/** `URL.hostname` keeps the brackets of an IPv6 literal; the address policy works without them. */
const hostOf = (url: URL) => url.hostname.replace(/^\[|\]$/g, '');

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

const view = (data: { buffer: ArrayBufferLike; byteOffset: number; byteLength: number }) =>
  new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return concatBytes(data.map(view));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return view(data);
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
  const text = new TextDecoder();
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
            isBinary ? toBytes(data) : text.decode(toBytes(data)),
            isBinary,
          );
        return subscribe('message', listener);
      }
      if (event === 'close') {
        const listener = (code: number, reason: Uint8Array) =>
          (fn as (code: number, reason: string) => void)(code, text.decode(reason));
        return subscribe('close', listener);
      }
      return subscribe(event, fn);
    },
  } as WebSocketLike;
}

type ConnectionOptions = { host?: string; port?: number | string; servername?: string };
type ConnectionCallback = (error: Error | null, socket?: unknown) => void;

/**
 * The production `ovo.net`: an address-guarded fetch and `ws`, https:/wss: only. Each call takes
 * its own AbortSignal (fetch `init.signal`); redirects are never followed silently. Every socket
 * goes through `net-pinning.ts`, so no plugin can reach a private or special-use address (#24).
 */
export function createNodeNet(options: NodeNetOptions = {}): NodeNet {
  const fetchImpl = options.fetch ?? (undiciFetch as unknown as typeof globalThis.fetch);
  const pinnable = options.fetch === undefined;
  const guard: PublicHostOptions = { allowedPrivateAddresses: options.allowedPrivateAddresses };
  const tls: TlsTrustOptions = {
    ca: options.tls?.ca ?? options.websocketOptions?.ca,
    rejectUnauthorized:
      options.tls?.rejectUnauthorized ?? options.websocketOptions?.rejectUnauthorized,
  };
  const agents = new PinnedAgents(tls);
  const policy = (addresses: readonly ResolvedAddress[]): AddressPolicy => ({
    ...guard,
    addresses,
  });

  const createConnection =
    (host: string) => (conn: ConnectionOptions, callback: ConnectionCallback) => {
      void (async () => {
        try {
          const addresses = await assertPublicHost(host, options.lookup, guard);
          createGuardedConnector(policy(addresses), tls)(
            {
              hostname: host,
              host,
              protocol: 'https:',
              port: String(conn.port ?? 443),
              ...(conn.servername === undefined ? {} : { servername: conn.servername }),
            },
            (error, socket) => callback(error, socket ?? undefined),
          );
        } catch (error) {
          callback(error as Error);
        }
      })();
      return undefined;
    };

  return {
    async fetch(url, init = {}) {
      const host = hostOf(secureUrl(url, 'https:'));
      init.signal?.throwIfAborted();
      const addresses = await assertPublicHost(host, options.lookup, guard);
      const request: RequestInit = {
        ...init,
        redirect: init.redirect === 'manual' ? 'manual' : 'error',
      };
      if (!pinnable) return fetchImpl(url, request);
      return fetchImpl(url, {
        ...request,
        dispatcher: agents.for(host, policy(addresses)),
      } as RequestInit);
    },
    websocket(url, opts = {}) {
      const host = hostOf(secureUrl(url, 'wss:'));
      const socket = new WebSocket(url, opts.protocols ?? [], {
        ...options.websocketOptions,
        headers: opts.headers ?? {},
        perMessageDeflate: false,
        followRedirects: false,
        maxPayload: options.maxPayload ?? 16 * 1024 * 1024,
        // `ws` types `createConnection` as node's synchronous `net.createConnection`. The socket
        // cannot be handed back before its peer is known, so we take the callback form that
        // http.ClientRequest also accepts and return nothing.
        createConnection: createConnection(host) as unknown as ClientOptions['createConnection'],
      });
      return wrapWebSocket(socket);
    },
    close: () => agents.close(),
  };
}
