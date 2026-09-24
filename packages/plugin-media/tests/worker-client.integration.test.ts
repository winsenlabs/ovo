import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MediaGateway } from '../src/gateway.ts';
import type { DurableMediaRoute, MediaRouteResolver } from '../src/ports.ts';
import { WorkerGatewayClient, WorkerMediaSession } from '../src/worker-client.ts';
import { connectRaw } from './gateway-socket-fixture.ts';

const publicBase = 'https://voice.example.test';
const path = '/twilio/media?edge=loopback';
const signature = createHmac('sha1', 'twilio-test-token')
  .update(`${publicBase}${path}`)
  .digest('base64');

async function carrier(port: number, callSid: string, sessionId: string, streamSid: string) {
  const socket = await connectRaw(port, path, signature);
  socket.send({
    event: 'start',
    sequenceNumber: '1',
    streamSid,
    start: {
      accountSid: 'AC1',
      callSid,
      customParameters: { sessionId, routeToken: `route-token-${sessionId.at(-1)}` },
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: '8000', channels: '1' },
    },
  });
  return socket;
}

describe('worker gateway client session isolation', () => {
  it('bounds frames queued before acceptance and closes only that session on overflow', async () => {
    const send = vi.fn();
    const socket = { readyState: WebSocket.OPEN, bufferedAmount: 0, send } as unknown as WebSocket;
    const session = new WorkerMediaSession(
      {
        sessionId: 'session-queue',
        callSid: 'CA-queue',
        streamSid: 'MZ-queue',
        ownerId: 'worker-1',
        ownerEpoch: 1,
        generation: 1,
      },
      socket,
      {
        maxBufferedBytes: 1024,
        maxPendingFrames: 2,
        backpressureTimeoutMs: 100,
        maxAudioFrameBytes: 64,
      },
    );
    await session.sendAudio(Uint8Array.of(1));
    await session.sendAudio(Uint8Array.of(2));
    await expect(session.sendAudio(Uint8Array.of(3))).rejects.toThrow(
      'pre-accept media buffer exceeded',
    );
    expect(session.isClosed).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    expect(JSON.parse(send.mock.calls[0]![0])).toMatchObject({
      type: 'session.close',
      reason: 'pre-accept media buffer exceeded',
    });
  });

  it('keeps the worker connected when one session fails before acceptance', async () => {
    const routes = [
      { sessionId: 'session-1', carrierCallId: 'CA1' },
      { sessionId: 'session-2', carrierCallId: 'CA2' },
    ].map(
      (route) =>
        ({
          ...route,
          workerId: 'worker-1',
          ownerEpoch: 1,
          generation: 1,
          status: 'accepted',
        }) as DurableMediaRoute,
    );
    const resolver: MediaRouteResolver = {
      authenticateSessionRoute: async (sessionId, token) =>
        token === `route-token-${sessionId.at(-1)}`
          ? routes.find((route) => route.sessionId === sessionId)
          : undefined,
      resolveSessionRoute: async ({ carrierCallId }) =>
        routes.find((route) => route.carrierCallId === carrierCallId),
    };
    const gateway = new MediaGateway(resolver, {
      publicBaseUrl: publicBase,
      twilioAuthToken: 'twilio-test-token',
      workerToken: 'worker-token',
    });
    const { port } = await gateway.listen();
    const worker = new WorkerGatewayClient(
      { url: `ws://127.0.0.1:${port}/worker`, workerId: 'worker-1', token: 'worker-token' },
      async (session) => {
        if (session.identity.callSid === 'CA1') throw new Error('first session cannot open');
        await session.sendAudio(Uint8Array.of(1, 2, 3));
        await session.sendMark('second-speaks');
      },
    );
    let first: Awaited<ReturnType<typeof carrier>> | undefined;
    let second: Awaited<ReturnType<typeof carrier>> | undefined;
    try {
      await worker.connect();
      first = await carrier(port, 'CA1', 'session-1', 'MZ1');
      await vi.waitFor(() => expect(first!.closed).toBe(true));
      second = await carrier(port, 'CA2', 'session-2', 'MZ2');
      await vi.waitFor(() =>
        expect(second!.messages.some((raw) => JSON.parse(raw).event === 'mark')).toBe(true),
      );
      expect(second.closed).toBe(false);
      expect(second.messages.some((raw) => JSON.parse(raw).event === 'media')).toBe(true);
    } finally {
      first?.close();
      second?.close();
      await worker.close();
      await gateway.close();
    }
  });
});
