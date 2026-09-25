import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { GatewayToWorkerMessage } from './ports.ts';
import { parseGatewayMessage } from './protocol.ts';

function bearer(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : undefined;
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The worker mounts this handler on its existing health server, never on a second port. */
export function attachWorkerMediaServer(input: {
  httpServer: Server;
  token: string;
  onOpen(
    open: Extract<GatewayToWorkerMessage, { type: 'session.open' }>,
    socket: WebSocket,
    handoff: () => void,
  ): Promise<void>;
}): () => Promise<void> {
  const server = new WebSocketServer({
    noServer: true,
    maxPayload: 1_048_576,
    perMessageDeflate: false,
  });
  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (new URL(request.url ?? '/', 'http://worker').pathname !== '/internal/media') return;
    const token = bearer(request);
    if (!token || !equal(token, input.token)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    server.handleUpgrade(request, socket, head, (ws) => {
      let phase: 'waiting' | 'authenticating' | 'ready' | 'closed' = 'waiting';
      ws.once('close', () => {
        phase = 'closed';
      });
      ws.once('message', (data, binary) => {
        if (binary) return ws.close(1008, 'binary session.open');
        try {
          const open = parseGatewayMessage(data.toString(), 65_536);
          if (open.type !== 'session.open') throw new Error('session.open required');
          phase = 'authenticating';
          // The durable route lookup awaits SQL. No frame can disappear in that gap.
          const earlyFrame = () => {
            if (phase === 'authenticating') ws.close(1008, 'media before session acceptance');
          };
          ws.on('message', earlyFrame);
          const handoff = () => {
            if (phase !== 'authenticating' || ws.readyState !== WebSocket.OPEN)
              throw new Error('worker media socket closed before acceptance');
            ws.off('message', earlyFrame);
            phase = 'ready';
          };
          void input
            .onOpen(open, ws, handoff)
            .then(() => {
              if (phase === 'authenticating') ws.close(1011, 'worker handler did not accept');
            })
            .catch((error) => {
              if (ws.readyState !== WebSocket.OPEN) return;
              ws.send(
                JSON.stringify({
                  type: 'session.reject',
                  reason: error instanceof Error ? error.message : 'session refused',
                }),
              );
              ws.close(1008, 'session refused');
            });
        } catch {
          ws.close(1008, 'invalid session.open');
        }
      });
    });
  };
  input.httpServer.on('upgrade', onUpgrade);
  return async () => {
    input.httpServer.off('upgrade', onUpgrade);
    for (const socket of server.clients) socket.close(1001, 'worker draining');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}
