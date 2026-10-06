import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from '@winsendotai/ovo-contracts';
import { createLogger, errorFields } from '@winsendotai/ovo-plugin-kit';
import type { MediaRouteResolver } from './ports.ts';
import { CarrierRouter } from './router.ts';
import { SessionBridge } from './session-bridge.ts';
import { WorkerDialer } from './worker-dialer.ts';
import type { MediaGatewayConfig } from './gateway-types.ts';

export type { MediaGatewayConfig } from './gateway-types.ts';

/** The process host owns HTTP; each carrier session owns one worker connection. */
export class MediaGateway {
  private readonly server: Server;
  private readonly router: CarrierRouter;
  private readonly sessions = new Set<SessionBridge>();
  private readonly log: Logger;
  private draining = false;
  private closed = false;

  constructor(
    resolver: MediaRouteResolver,
    private readonly config: MediaGatewayConfig,
  ) {
    const log = (this.log = config.logger ?? createLogger({ service: 'media-gateway' }));
    const dialer = new WorkerDialer({
      workerToken: config.workerToken,
      handshakeTimeoutMs: config.handshakeTimeoutMs,
      maxMessageBytes: config.maxMessageBytes,
      logger: log,
    });
    this.router = new CarrierRouter({
      ingresses: config.ingresses,
      publicBaseUrl: config.publicBaseUrl,
      hostFor: config.hostFor,
      logger: log,
      onConnected: (accepted) => {
        if (this.draining) {
          accepted.socket.close(1012, 'gateway draining');
          return;
        }
        const session = new SessionBridge({
          accepted,
          resolver,
          dialer,
          preAcceptBufferMs:
            config.preAcceptBufferMs ??
            (config.maxPendingFrames === undefined ? undefined : config.maxPendingFrames * 20),
          maxAudioFrameBytes: config.maxAudioFrameBytes,
          maxBufferedBytes: config.maxBufferedBytes,
          handshakeTimeoutMs: config.handshakeTimeoutMs,
          idleTimeoutMs: config.idleTimeoutMs,
          logger: log,
          onClosed: (reason, identity, timings) => {
            this.sessions.delete(session);
            log.info('carrier_session_closed', {
              carrierId: accepted.ingress.carrierId,
              bindingId: accepted.bindingId,
              ...identity,
              reason,
              ...timings,
            });
            config.health?.sessionClosed?.(reason);
          },
        });
        this.sessions.add(session);
      },
    });
    this.server = createServer((request, response) => {
      const [path, query = ''] = (request.url ?? '').split('?', 2);
      if (path === '/health') {
        void this.health(request, new URLSearchParams(query).get('verbose') === '1').then(
          ({ status, body }) => {
            response.writeHead(status, { 'content-type': 'application/json' });
            response.end(JSON.stringify(body));
          },
          (error: unknown) => {
            log.error('gateway_health_failed', errorFields(error));
            response.writeHead(500).end();
          },
        );
        return;
      }
      if (this.draining) {
        response.writeHead(503).end();
        return;
      }
      void this.router.handleHttp(request, response).then(
        (handled) => {
          if (!handled) response.writeHead(404).end();
        },
        (error: unknown) => {
          log.error('carrier_http_failed', {
            method: request.method,
            path: request.url?.split('?', 1)[0],
            ...errorFields(error),
          });
          response.writeHead(500).end();
        },
      );
    });
    this.server.on('upgrade', (request, socket, head) => {
      if (this.draining) {
        socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
        return;
      }
      void this.router.handleUpgrade(request, socket, head);
    });
  }

  /** `/health` is unchanged; `?verbose=1` adds the host's live-path state behind its token. */
  private async health(request: IncomingMessage, verbose: boolean) {
    const basic = { ready: !this.draining, sessions: this.sessions.size };
    if (!verbose) return { status: this.draining ? 503 : 200, body: basic };
    const token = this.config.health?.token;
    const header = request.headers.authorization;
    const presented = Buffer.from(
      typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '',
    );
    const expected = Buffer.from(token ?? '');
    if (!token || presented.length !== expected.length || !timingSafeEqual(presented, expected))
      return {
        status: token ? 401 : 403,
        body: { error: token ? 'unauthorized' : 'verbose_disabled' },
      };
    return {
      status: this.draining ? 503 : 200,
      body: { ...basic, live: await this.config.health!.verbose() },
    };
  }

  async listen(): Promise<{ host: string; port: number }> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.config.port ?? 0, this.config.host ?? '127.0.0.1', resolve);
    });
    const address = this.server.address() as AddressInfo;
    return { host: address.address, port: address.port };
  }

  async drain(): Promise<void> {
    if (this.closed) return;
    this.draining = true;
    const deadline = Date.now() + (this.config.drainTimeoutMs ?? 270_000);
    while (this.sessions.size && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    await this.close();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.draining = true;
    // Dropping the gateway link gives the carrier a chance to resume on another
    // replica. A session.close frame would terminate the worker's live engine.
    for (const session of this.sessions) session.close('gateway drain deadline', false);
    this.sessions.clear();
    this.router.close();
    if (!this.server.listening) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
