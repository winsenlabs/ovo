import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type {
  CarrierHostPorts,
  CarrierHttpRoute,
  CarrierIngress,
} from '@winsendotai/ovo-contracts';
import {
  CarrierUpgradeRouter,
  publicRequestUrl,
  queryFields,
  requestHeaders,
  type AcceptedCarrierUpgrade,
  type UpgradeMatch,
} from './upgrade.ts';

interface MatchedCarrierRoute extends UpgradeMatch {
  purpose: CarrierHttpRoute['purpose'] | 'media';
}

export interface CarrierRouterOptions {
  ingresses: readonly CarrierIngress[];
  publicBaseUrl: string;
  hostFor(carrierId: string, bindingId: string): CarrierHostPorts;
  onConnected(accepted: AcceptedCarrierUpgrade): void | Promise<void>;
}

/** Carrier-neutral HTTP and upgrade dispatch; serializers own carrier authentication. */
export class CarrierRouter {
  private readonly carriers = new Map<string, CarrierIngress>();
  private readonly aliases = new Map<string, MatchedCarrierRoute>();
  private readonly upgrades: CarrierUpgradeRouter;

  constructor(private readonly options: CarrierRouterOptions) {
    publicRequestUrl(options.publicBaseUrl, '/', 'https');
    for (const ingress of options.ingresses) {
      if (this.carriers.has(ingress.carrierId))
        throw new TypeError(`Duplicate carrier ingress ${ingress.carrierId}`);
      this.carriers.set(ingress.carrierId, ingress);
      for (const [path, alias] of Object.entries(ingress.legacyPaths ?? {})) {
        if (!path.startsWith('/') || path.includes('?') || path.includes('#'))
          throw new TypeError(`Invalid carrier alias ${path}`);
        if (this.aliases.has(path)) throw new TypeError(`Duplicate carrier alias ${path}`);
        this.aliases.set(path, {
          ingress,
          bindingId: alias.bindingId,
          purpose: alias.purpose,
        });
      }
    }
    this.upgrades = new CarrierUpgradeRouter({
      publicBaseUrl: options.publicBaseUrl,
      hostFor: options.hostFor,
      onConnected: options.onConnected,
      match: (pathname) => {
        const route = this.match(pathname);
        return route?.purpose === 'media'
          ? { ingress: route.ingress, bindingId: route.bindingId }
          : undefined;
      },
    });
  }

  /** Returns false only for a path owned by another gateway surface, such as /health. */
  async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const rawUrl = request.url ?? '/';
    const pathname = rawUrl.split('?', 1)[0]!;
    if (!pathname.startsWith('/carriers/') && !this.aliases.has(pathname)) return false;
    try {
      const publicUrl = publicRequestUrl(this.options.publicBaseUrl, rawUrl, 'https');
      const match = this.match(publicUrl.pathname);
      const route = match?.ingress.routes.find(
        (candidate) => candidate.purpose === match.purpose && candidate.method === request.method,
      );
      if (!match || !route || match.purpose === 'media') {
        response.writeHead(404).end();
        return true;
      }
      const rawBody = await readBody(request, 1024 * 1024);
      const host = this.options.hostFor(match.ingress.carrierId, match.bindingId);
      const reply = await route.handle(
        {
          method: route.method,
          externalUrl: publicUrl.externalUrl,
          query: queryFields(publicUrl.url),
          headers: requestHeaders(request),
          rawBody,
          bindingId: match.bindingId,
          remoteAddress: request.socket.remoteAddress,
        },
        host,
      );
      response.writeHead(reply.status, { 'content-type': reply.contentType }).end(reply.body);
      return true;
    } catch (error) {
      response
        .writeHead(error instanceof RangeError ? 413 : error instanceof TypeError ? 400 : 500)
        .end();
      return true;
    }
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    return this.upgrades.handle(request, socket, head);
  }

  close(): void {
    this.upgrades.close();
  }

  private match(pathname: string): MatchedCarrierRoute | undefined {
    const alias = this.aliases.get(pathname);
    if (alias) return alias;
    const parts = /^\/carriers\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(pathname);
    if (!parts) return undefined;
    try {
      const carrierId = decodeURIComponent(parts[1]!);
      const bindingId = decodeURIComponent(parts[2]!);
      const purpose = parts[3]!;
      if (
        !carrierId ||
        !bindingId ||
        carrierId.includes('/') ||
        bindingId.includes('/') ||
        carrierId === '.' ||
        bindingId === '..'
      )
        return undefined;
      const ingress = this.carriers.get(carrierId);
      if (!ingress) return undefined;
      if (purpose !== 'media' && !ingress.routes.some((route) => route.purpose === purpose))
        return undefined;
      return {
        ingress,
        bindingId,
        purpose: purpose as MatchedCarrierRoute['purpose'],
      };
    } catch {
      return undefined;
    }
  }
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maxBytes) throw new RangeError('Carrier HTTP body exceeds limit');
    chunks.push(bytes);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
