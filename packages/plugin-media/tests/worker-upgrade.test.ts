import { once } from 'node:events';
import { createServer } from 'node:http';
import { MULAW_8K } from '@winsendotai/ovo-contracts';
import WebSocket from 'ws';
import { expect, it, vi } from 'vitest';
import { attachWorkerMediaServer } from '../src/worker-upgrade.ts';

const open = {
  type: 'session.open',
  protocol: 2,
  sessionId: 'session-1',
  carrierId: 'fixture',
  bindingId: 'env',
  carrierCallId: 'CA-1',
  streamId: 'MZ-1',
  ownerEpoch: 1,
  generation: 1,
  format: MULAW_8K,
  playbackEvidence: 'carrier-played',
  clearFlushesMarkers: true,
  routeToken: 'token',
};

it('rejects an early media frame during asynchronous worker route authentication', async () => {
  const httpServer = createServer();
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('worker has no port');
  let release!: () => void;
  const onOpen = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
  const detach = attachWorkerMediaServer({ httpServer, token: 'secret', onOpen });
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/internal/media`, {
    headers: { authorization: 'Bearer secret' },
  });
  try {
    await once(socket, 'open');
    socket.send(JSON.stringify(open));
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledOnce());
    socket.send(
      JSON.stringify({ type: 'media.audio', payload: 'AQ==', sequenceNumber: 1, timestampMs: 0 }),
    );
    await vi.waitFor(() => expect(socket.readyState).toBe(WebSocket.CLOSED));
  } finally {
    release?.();
    socket.terminate();
    await detach();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
});
