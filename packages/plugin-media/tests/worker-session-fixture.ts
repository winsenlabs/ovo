import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { MULAW_8K, type AudioFormat } from '@winsendotai/ovo-contracts';
import type { GatewayToWorkerMessage, WorkerToGatewayMessage } from '../src/ports.ts';

type Route = {
  sessionId: string;
  jobId: string;
  organizationId: string;
  workerId: string;
  ownerEpoch: number;
  generation: number;
  carrierId?: string;
  carrierCallId?: string;
  bindingId?: string | null;
};
type Runtime = { start(): Promise<void>; close(): Promise<void> };

/** Transport fixture for the real runtime admission path; SQL durability has a separate PG proof. */
export async function workerSessionFixture<R extends Route, J>(
  route: R,
  job: J,
  create: (server: Server, store: ReturnType<typeof routeStore<R, J>>) => Runtime,
  onMessage?: (message: WorkerToGatewayMessage) => void,
  format: AudioFormat = MULAW_8K,
) {
  const server = createServer((_request, response) => response.writeHead(404).end());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('worker has no loopback port');
  const store = routeStore(route, job);
  const runtime = create(server, store);
  await runtime.start();
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/internal/media`, {
    headers: { authorization: 'Bearer worker-fixture-token' },
  });
  const messages: WorkerToGatewayMessage[] = [];
  const send = (message: GatewayToWorkerMessage) => socket.send(JSON.stringify(message));
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString()) as WorkerToGatewayMessage;
    messages.push(message);
    onMessage?.(message);
    if (message.type === 'mark')
      send({ type: 'media.played', name: message.name, evidence: 'carrier-played' });
  });
  await once(socket, 'open');
  const first = once(socket, 'message');
  send({
    type: 'session.open',
    protocol: 2,
    sessionId: route.sessionId,
    carrierId: route.carrierId ?? 'fixture',
    bindingId: route.bindingId ?? 'env',
    carrierCallId: route.carrierCallId!,
    streamId: 'stream-fixture',
    ownerEpoch: route.ownerEpoch,
    generation: route.generation,
    format,
    playbackEvidence: 'carrier-played',
    clearFlushesMarkers: true,
    routeToken: 'route-fixture-token',
  });
  await first;
  return {
    messages,
    send,
    sendRaw: (bytes: Uint8Array) => socket.send(bytes),
    store,
    async close() {
      await runtime.close();
      socket.terminate();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function routeStore<R extends Route, J>(route: R, job: J) {
  const queries: string[] = [];
  return {
    queries,
    get: async () => job,
    resolveSessionRoute: async () => route,
    pool: {
      async query(sql: string, values: unknown[] = []) {
        queries.push(sql);
        if (sql.includes('INSERT INTO ovo_carrier_callbacks')) return { rows: [], rowCount: 1 };
        if (sql.includes('FROM ovo_worker_slots')) return { rows: [{ ownership_epoch: '7' }] };
        if (sql.includes('FROM ovo_session_routes') && values[0] !== route.sessionId)
          return { rows: [] };
        if (sql.includes('FROM ovo_session_routes'))
          return {
            rows: [
              {
                job_id: route.jobId,
                organization_id: route.organizationId,
                carrier_id: route.carrierId,
                handshake_token_hash: createHash('sha256')
                  .update('route-fixture-token')
                  .digest('hex'),
                handshake_claimed_at: new Date(),
                worker_slot_epoch: '7',
              },
            ],
          };
        throw new Error(`Unexpected fixture SQL: ${sql}`);
      },
    },
  };
}
