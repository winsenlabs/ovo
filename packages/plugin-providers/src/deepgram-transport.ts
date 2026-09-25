import WebSocket, { type ClientOptions } from 'ws';
import { abortError } from './abort.ts';
import { ProviderProtocolError } from './types.ts';

export type DeepgramWebSocketFactory = (url: string, options: ClientOptions) => WebSocket;

export async function openDeepgramSocket(
  factory: DeepgramWebSocketFactory,
  url: string,
  options: ClientOptions,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<WebSocket> {
  const socket = factory(url, options);
  return new Promise<WebSocket>((resolve, reject) => {
    const timer = setTimeout(
      () => fail(new DOMException('Deepgram connect deadline exceeded', 'TimeoutError')),
      timeoutMs,
    );
    const abort = () => fail(abortError(signal));
    const opened = () => settle(() => resolve(socket));
    const error = (reason: Error) => fail(reason);
    const closed = (code: number) =>
      fail(new ProviderProtocolError(`Deepgram closed while connecting (${code})`));
    const settle = (done: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      socket.off('open', opened).off('error', error).off('close', closed);
      done();
    };
    const fail = (reason: Error) =>
      settle(() => {
        socket.once('error', () => undefined);
        socket.close();
        reject(reason);
      });
    if (signal.aborted) abort();
    else {
      signal.addEventListener('abort', abort, { once: true });
      socket.once('open', opened).once('error', error).once('close', closed);
    }
  });
}

export function validateDeepgramEndpoint(endpoint: string, allowPrivateTestEndpoint = false): URL {
  const url = new URL(endpoint);
  if (
    url.protocol !== 'wss:' ||
    url.pathname !== '/v1/listen' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new TypeError('Deepgram endpoint must be an exact credential-free WSS /v1/listen URL');
  if (!allowPrivateTestEndpoint && url.hostname !== 'api.deepgram.com')
    throw new TypeError('Only the official Deepgram endpoint is allowed');
  return url;
}

export function waitForReconnect(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => finish(() => reject(abortError(signal)));
    function finish(action: () => void) {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      action();
    }
    function done() {
      finish(resolve);
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}
