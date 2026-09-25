import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type {
  CarrierHostPorts,
  CarrierIngress,
  CarrierHttpRequest,
  MediaCodecSession,
} from '@winsendotai/ovo-contracts';

export interface UpgradeMatch {
  ingress: CarrierIngress;
  bindingId: string;
}

export interface AcceptedCarrierUpgrade extends UpgradeMatch {
  socket: WebSocket;
  params: Record<string, string>;
  codec: MediaCodecSession;
}

export interface CarrierUpgradeOptions {
  publicBaseUrl: string;
  match(pathname: string): UpgradeMatch | undefined;
  hostFor(carrierId: string, bindingId: string): CarrierHostPorts;
  onConnected(accepted: AcceptedCarrierUpgrade): void | Promise<void>;
}

/** The public URL uses the configured origin and the exact request path, never proxy headers. */
export function publicRequestUrl(
  publicBaseUrl: string,
  requestUrl: string,
  scheme: 'https' | 'wss',
): { url: URL; externalUrl: string; pathname: string } {
  const base = new URL(publicBaseUrl);
  if (base.protocol !== 'https:') throw new TypeError('publicBaseUrl must use HTTPS');
  if (!requestUrl.startsWith('/') || requestUrl.startsWith('//') || requestUrl.includes('#'))
    throw new TypeError('Carrier request URL must be an origin-relative path');
  const pathname = requestUrl.split('?', 1)[0]!;
  const externalUrl = `${scheme}://${base.host}${pathname}`;
  const url = new URL(`${scheme}://${base.host}${requestUrl}`);
  if (url.pathname !== pathname) throw new TypeError('Carrier request path must be canonical');
  return { url, externalUrl, pathname };
}

export function requestHeaders(request: IncomingMessage): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(request.headers).map(([name, value]) => [
      name,
      typeof value === 'string' ? value : undefined,
    ]),
  );
}

export function queryFields(url: URL): Record<string, string> {
  const query: Record<string, string> = {};
  for (const [name, value] of url.searchParams) {
    if (Object.hasOwn(query, name)) throw new TypeError('Duplicate carrier query parameter');
    query[name] = value;
  }
  return query;
}

export function rejectCarrierUpgrade(socket: Duplex, status: number): void {
  socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`);
}

/** Authenticates before ws.handleUpgrade; an unauthenticated socket never becomes a peer. */
export class CarrierUpgradeRouter {
  private readonly server = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    perMessageDeflate: false,
  });

  constructor(private readonly options: CarrierUpgradeOptions) {}

  async handle(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    try {
      if (request.method !== 'GET') return rejectCarrierUpgrade(socket, 404);
      const publicUrl = publicRequestUrl(this.options.publicBaseUrl, request.url ?? '/', 'wss');
      const match = this.options.match(publicUrl.pathname);
      if (!match) return rejectCarrierUpgrade(socket, 404);
      const host = this.options.hostFor(match.ingress.carrierId, match.bindingId);
      const headers = requestHeaders(request);
      const remoteAddress = request.socket.remoteAddress;
      const httpUrl = publicRequestUrl(this.options.publicBaseUrl, request.url ?? '/', 'https');
      const query = queryFields(publicUrl.url);
      const verified = await match.ingress.serializer.authenticateUpgrade(
        {
          url: publicUrl.url,
          externalUrl: publicUrl.externalUrl,
          headers,
          remoteAddress,
        },
        {
          bindingId: match.bindingId,
          resolveBinding: (id) => {
            if (id !== match.bindingId) throw new TypeError('Carrier binding mismatch');
            return host.resolveBinding(id);
          },
          verifyUrlSecret: ({ bindingId, requestId, token }) => {
            if (bindingId !== match.bindingId || token === null) return false;
            const verificationRequest: CarrierHttpRequest = {
              method: 'GET',
              externalUrl: httpUrl.externalUrl,
              query: { ...query, t: token },
              headers,
              rawBody: new Uint8Array(0),
              bindingId: match.bindingId,
              remoteAddress,
            };
            return host.verifyUrlSecret(verificationRequest, {
              purpose: 'media',
              ...(requestId ? { requestId } : {}),
            });
          },
        },
      );
      if (!verified.ok) return rejectCarrierUpgrade(socket, verified.status);
      this.server.handleUpgrade(request, socket, head, (peer) => {
        try {
          const codec = match.ingress.serializer.createSession(verified.params);
          void Promise.resolve()
            .then(() =>
              this.options.onConnected({
                socket: peer,
                ingress: match.ingress,
                bindingId: match.bindingId,
                params: verified.params,
                codec,
              }),
            )
            .catch(() => peer.close(1011, 'carrier session setup failed'));
        } catch {
          peer.close(1011, 'carrier session setup failed');
        }
      });
    } catch {
      rejectCarrierUpgrade(socket, 400);
    }
  }

  close(): void {
    this.server.close();
  }
}
