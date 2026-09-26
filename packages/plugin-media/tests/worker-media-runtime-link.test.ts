import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { MULAW_8K } from '@winsendotai/ovo-contracts';
import type { SessionRoute } from '../../plugin-orchestration/src/index.ts';
import { describe, expect, it, vi } from 'vitest';
import { WorkerMediaLink } from '../../../apps/worker/src/worker-media-server.ts';

function fixture() {
  const route: SessionRoute = {
    sessionId: 'session-1',
    jobId: 'job-1',
    organizationId: 'workspace-1',
    workerId: 'worker-1',
    workerEndpoint: 'ws://worker-1/internal/media',
    ownerEpoch: 7,
    generation: 2,
    dialRequestId: 'job-1:7',
    carrierCallId: 'CA1',
    status: 'accepted',
    handshakeExpiresAt: new Date(Date.now() + 60_000),
  };
  return { route };
}

function sessionOpen(route: SessionRoute, routeToken = 'token') {
  if (!route.carrierCallId) throw new Error('fixture route has no carrier call ID');
  return {
    type: 'session.open',
    protocol: 2,
    sessionId: route.sessionId,
    carrierId: route.carrierId ?? 'twilio',
    bindingId: route.bindingId ?? 'env',
    carrierCallId: route.carrierCallId,
    streamId: 'MZ1',
    ownerEpoch: route.ownerEpoch,
    generation: route.generation,
    format: MULAW_8K,
    playbackEvidence: 'carrier-played',
    clearFlushesMarkers: true,
    routeToken,
  } as const;
}

describe('worker media runtime', () => {
  it('notifies finalization after a long Unicode carrier close reason', () => {
    const { route } = fixture();
    const socket = new EventEmitter() as EventEmitter & {
      close(code: number, reason: string): void;
    };
    socket.close = vi.fn((_code, reason) => {
      if (Buffer.byteLength(reason, 'utf8') > 123)
        throw new RangeError('WebSocket close reason exceeds 123 bytes');
    });
    const link = new WorkerMediaLink(sessionOpen(route), socket as unknown as WebSocket);
    const onClose = vi.fn();
    link.onClose(onClose);
    const reason = '😵'.repeat(120);
    link.finish(reason);
    expect(onClose).toHaveBeenCalledWith(reason);
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it('ignores audio and close frames from a superseded gateway generation', () => {
    const { route } = fixture();
    const peer = () => {
      const socket = new EventEmitter() as EventEmitter & {
        readyState: number;
        bufferedAmount: number;
        send(value: string): void;
        close(): void;
      };
      socket.readyState = WebSocket.OPEN;
      socket.bufferedAmount = 0;
      socket.send = vi.fn();
      socket.close = vi.fn();
      return socket;
    };
    const oldPeer = peer();
    const newPeer = peer();
    const link = new WorkerMediaLink(sessionOpen(route), oldPeer as unknown as WebSocket);
    const audio = vi.fn();
    const onClose = vi.fn();
    link.onAudio(audio);
    link.onClose(onClose);
    link.activate();
    link.rebind(
      { ...sessionOpen(route), generation: route.generation + 1, streamId: 'MZ2' },
      newPeer as unknown as WebSocket,
    );
    oldPeer.emit(
      'message',
      Buffer.from(
        JSON.stringify({ type: 'media.audio', payload: 'AQ==', sequenceNumber: 1, timestampMs: 0 }),
      ),
      false,
    );
    oldPeer.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'session.close', reason: 'gateway drained' })),
      false,
    );
    oldPeer.emit('error', new Error('superseded peer transport failed'));
    expect(audio).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(link.isClosed).toBe(false);
    newPeer.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'media.audio',
          payload: 'Ag==',
          sequenceNumber: 2,
          timestampMs: 20,
        }),
      ),
      false,
    );
    expect(audio).toHaveBeenCalledOnce();
    expect(audio).toHaveBeenCalledWith(Buffer.from([2]), 20);
    newPeer.emit('error', new Error('active peer transport failed'));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith('error:media-transport');
    expect(link.isClosed).toBe(true);
  });

  it.each(['max_duration', 'ownership_lost'] as const)(
    'sends carrier termination and preserves the %s engine reason',
    async (reason) => {
      const sent: unknown[] = [];
      const socket = new EventEmitter() as EventEmitter & {
        readyState: number;
        bufferedAmount: number;
        send(value: string, callback?: (error?: Error) => void): void;
        close(): void;
      };
      socket.readyState = WebSocket.OPEN;
      socket.bufferedAmount = 0;
      socket.send = (value, callback) => {
        sent.push(JSON.parse(value));
        callback?.();
      };
      socket.close = vi.fn();
      const link = new WorkerMediaLink(
        sessionOpen(fixture().route),
        socket as unknown as WebSocket,
      );
      const onClose = vi.fn();
      link.onClose(onClose);
      await link.terminate(reason);
      expect(sent).toEqual([{ type: 'session.end', reason: 'terminate' }]);
      expect(onClose).toHaveBeenCalledWith(reason);
      await expect(link.clear()).resolves.toBeUndefined();
    },
  );
});
