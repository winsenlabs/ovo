import type { Clock, NetPort, WebSocketLike } from '@winsendotai/ovo-contracts';
import { abortError } from './abort.ts';
import { ProviderProtocolError } from './http.ts';

export interface ProviderSocketOptions {
  signal?: AbortSignal;
  /** Connect deadline; defaults to 10 s. */
  timeoutMs?: number;
  protocols?: string[];
  clock?: Pick<Clock, 'setTimeout'>;
}

const systemTimer: Pick<Clock, 'setTimeout'> = {
  setTimeout(fn, ms) {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

/** Validates a provider WebSocket URL: wss:, an allow-listed host, no credentials or fragment. */
export function validateSocketUrl(url: string, allowHosts: readonly string[]): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== 'wss:') throw new TypeError('Provider sockets must use wss:');
  if (parsed.username || parsed.password || parsed.hash)
    throw new TypeError('Provider socket URLs cannot carry credentials or fragments');
  const host = parsed.hostname.toLowerCase();
  if (!allowHosts.some((allowed) => allowed.toLowerCase() === host))
    throw new TypeError(`Provider socket host ${host} is not allowed`);
  return parsed;
}

/**
 * Opens a provider WebSocket through the host `NetPort` and resolves once it is open. Abort,
 * timeout or a close while connecting reject and close the socket.
 */
export function openProviderSocket(
  net: Pick<NetPort, 'websocket'>,
  url: string,
  headers: Record<string, string>,
  allowHosts: readonly string[],
  options: ProviderSocketOptions = {},
): Promise<WebSocketLike> {
  validateSocketUrl(url, allowHosts);
  const signal = options.signal;
  if (signal?.aborted) return Promise.reject(abortError(signal));
  const socket = net.websocket(url, { headers, protocols: options.protocols });
  const clock = options.clock ?? systemTimer;
  return new Promise<WebSocketLike>((resolve, reject) => {
    const unsubscribe: (() => void)[] = [];
    const settle = (done: () => void) => {
      cancelTimer();
      signal?.removeEventListener('abort', onAbort);
      for (const off of unsubscribe.splice(0)) off();
      done();
    };
    const fail = (reason: Error) =>
      settle(() => {
        try {
          socket.close(1000, 'connect aborted');
        } catch {
          // A socket that never opened may refuse a close code; it is discarded either way.
        }
        reject(reason);
      });
    const onAbort = () => fail(abortError(signal!));
    const cancelTimer = clock.setTimeout(
      () => fail(new DOMException('Provider connect deadline exceeded', 'TimeoutError')),
      options.timeoutMs ?? 10_000,
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    unsubscribe.push(
      socket.on('open', () => settle(() => resolve(socket))),
      socket.on('error', (error) => fail(error)),
      socket.on('close', (code) =>
        fail(new ProviderProtocolError(`Provider closed while connecting (${code})`)),
      ),
    );
  });
}

export interface KeepaliveOptions {
  intervalMs: number;
  message: () => string | Uint8Array;
  clock?: Pick<Clock, 'setTimeout'>;
}

/** Sends `message()` every `intervalMs` while the socket is open; stops on close or when called. */
export function keepalive(socket: WebSocketLike, options: KeepaliveOptions): () => void {
  const clock = options.clock ?? systemTimer;
  let stopped = false;
  let cancel = () => {};
  const tick = () => {
    if (stopped) return;
    if (socket.readyState === 1) {
      try {
        socket.send(options.message());
      } catch {
        stop();
        return;
      }
    }
    if (socket.readyState >= 2) return stop();
    cancel = clock.setTimeout(tick, options.intervalMs);
  };
  const offClose = socket.on('close', () => stop());
  function stop() {
    stopped = true;
    cancel();
    offClose();
  }
  cancel = clock.setTimeout(tick, options.intervalMs);
  return stop;
}
