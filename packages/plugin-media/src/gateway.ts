import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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
  private draining = false;
  private closed = false;

  constructor(
    resolver: MediaRouteResolver,
    private readonly config: MediaGatewayConfig,
  ) {
    const dialer = new WorkerDialer({
      workerToken: config.workerToken,
      handshakeTimeoutMs: config.handshakeTimeoutMs,
      maxMessageBytes: config.maxMessageBytes,
    });
    this.router = new CarrierRouter({
      ingresses: config.ingresses,
      publicBaseUrl: config.publicBaseUrl,
      hostFor: config.hostFor,
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
          onClosed: () => this.sessions.delete(session),
        });
        this.sessions.add(session);
      },
    });
    this.server = createServer((request, response) => {
      if (request.url === '/health') {
        response.writeHead(this.draining ? 503 : 200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ready: !this.draining, sessions: this.sessions.size }));
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
        () => response.writeHead(500).end(),
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
    const deadline = Date.now() + (this.config.drainTimeoutMs ?? 30_000);
    while (this.sessions.size && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    await this.close();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.draining = true;
    for (const session of this.sessions) session.close('gateway drain deadline');
    this.sessions.clear();
    this.router.close();
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
