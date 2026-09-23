import { readFileSync } from 'node:fs';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';

let certificate: { key: Buffer; cert: Buffer } | undefined;

/** The loopback test certificate (CN=localhost, SAN localhost and 127.0.0.1). Tests only. */
export function loopbackCertificate(): { key: Buffer; cert: Buffer } {
  certificate ??= {
    key: readFileSync(new URL('../../fixtures/tls/localhost-key.pem', import.meta.url)),
    cert: readFileSync(new URL('../../fixtures/tls/localhost-cert.pem', import.meta.url)),
  };
  return certificate;
}

export interface LoopbackServer {
  readonly port: number;
  /** `https://127.0.0.1:<port>` or `http://…` without TLS. */
  readonly origin: string;
  url(path: string, protocol?: 'http' | 'ws'): string;
  readonly sockets: readonly WebSocket[];
  close(): Promise<void>;
}

export interface LoopbackServerOptions {
  /** Defaults to true (https/wss with the loopback certificate). */
  tls?: boolean;
  onRequest?(request: IncomingMessage, response: ServerResponse): void;
  onConnection?(socket: WebSocket, request: IncomingMessage): void;
  /** Accept or refuse an upgrade before the WebSocket handshake completes. */
  verifyUpgrade?(request: IncomingMessage): boolean | { status: number };
}

/** An HTTP(S) + WS(S) server on 127.0.0.1 with an ephemeral port. Never a public interface. */
export async function startLoopbackServer(
  options: LoopbackServerOptions = {},
): Promise<LoopbackServer> {
  const secure = options.tls ?? true;
  const handler = (request: IncomingMessage, response: ServerResponse) => {
    if (options.onRequest) options.onRequest(request, response);
    else response.writeHead(404).end();
  };
  const server: Server = secure
    ? createHttpsServer(loopbackCertificate(), handler)
    : createHttpServer(handler);
  const sockets: WebSocket[] = [];
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    const verdict = options.verifyUpgrade?.(request) ?? true;
    if (verdict !== true) {
      const status = verdict === false ? 401 : verdict.status;
      socket.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      sockets.push(ws);
      options.onConnection?.(ws, request);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const scheme = secure ? 's' : '';
  return {
    port,
    origin: `http${scheme}://127.0.0.1:${port}`,
    sockets,
    url: (path, protocol = 'http') => `${protocol}${scheme}://127.0.0.1:${port}${path}`,
    async close() {
      for (const socket of sockets) socket.terminate();
      wss.close();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A fetch over node:https that trusts only the loopback certificate (verification stays on). */
export const loopbackFetch: typeof globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
  return new Promise<Response>((resolve, reject) => {
    const call = httpsRequest(
      new URL(request.url),
      {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        ca: loopbackCertificate().cert,
      },
      (response) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) value.forEach((entry) => headers.append(name, entry));
          else if (value !== undefined) headers.set(name, String(value));
        }
        const nullBody = [101, 204, 205, 304].includes(response.statusCode ?? 0);
        resolve(
          new Response(
            nullBody ? null : (Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>),
            { status: response.statusCode ?? 500, headers },
          ),
        );
      },
    );
    call.once('error', reject);
    const abort = () => call.destroy(request.signal.reason as Error | undefined);
    if (request.signal.aborted) abort();
    else request.signal.addEventListener('abort', abort, { once: true });
    call.end(body);
  });
};

/**
 * `createNodeNet` options that reach a loopback server while keeping TLS verification on. The
 * loopback addresses are named explicitly: `createNodeNet` refuses private peers otherwise.
 */
export function loopbackNetOptions(): {
  fetch: typeof globalThis.fetch;
  websocketOptions: { ca: Buffer };
  allowedPrivateAddresses: readonly string[];
} {
  return {
    fetch: loopbackFetch,
    websocketOptions: { ca: loopbackCertificate().cert },
    allowedPrivateAddresses: ['127.0.0.1', '::1'],
  };
}
