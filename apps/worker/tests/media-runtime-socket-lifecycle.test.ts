import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { WebSocket } from '@winsendotai/ovo-plugin-media';
import type { DurableJobStore, SessionRoute } from '@winsendotai/ovo-plugin-orchestration';
import { createLogger } from '@winsendotai/ovo-plugin-kit';
import { describe, expect, it, vi } from 'vitest';
import {
  sessionOpenFailure,
  WorkerMediaRuntime,
  type VoiceSessionFactory,
} from '../src/media-runtime.ts';
import { mediaRuntimeFixture, mediaSessionOpen } from './media-runtime-fixtures.ts';

async function withConnectedSocket(
  factory: VoiceSessionFactory,
  run: (context: {
    socket: WebSocket;
    runtime: WorkerMediaRuntime;
    route: SessionRoute;
    onSessionClose: ReturnType<typeof vi.fn>;
    beforeSessionOpen: ReturnType<typeof vi.fn>;
  }) => Promise<void>,
  options: { beforeSessionOpen?: () => Promise<void>; logs?: Record<string, unknown>[] } = {},
): Promise<void> {
  const { route, job } = mediaRuntimeFixture();
  const server = createServer((_request, response) => response.writeHead(404).end());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('worker test server has no port');
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('INSERT INTO ovo_carrier_callbacks')) return { rows: [], rowCount: 1 };
    if (sql.includes('FROM ovo_session_routes'))
      return {
        rows: [
          {
            job_id: job.id,
            organization_id: route.organizationId,
            carrier_id: route.carrierId,
            handshake_token_hash: createHash('sha256').update('token').digest('hex'),
            handshake_claimed_at: new Date(),
            worker_slot_epoch: 'slot-1',
          },
        ],
      };
    if (sql.includes('FROM ovo_worker_slots')) return { rows: [{ ownership_epoch: 'slot-1' }] };
    throw new Error(`Unexpected media route query: ${sql}`);
  });
  const onSessionClose = vi.fn(async () => undefined);
  const beforeSessionOpen = vi.fn(options.beforeSessionOpen ?? (async () => undefined));
  const logger = createLogger({}, { sink: (line) => options.logs?.push(JSON.parse(line)) });
  const runtime = new WorkerMediaRuntime(
    { workerId: route.workerId, token: 'test', httpServer: server, logger },
    {
      pool: { query },
      resolveSessionRoute: vi.fn(async () => route),
      get: vi.fn(async () => job),
    } as unknown as DurableJobStore,
    factory,
    onSessionClose,
    beforeSessionOpen,
  );
  let socket: WebSocket | undefined;
  try {
    await runtime.start();
    socket = new WebSocket(`ws://127.0.0.1:${address.port}/internal/media`, {
      headers: { authorization: 'Bearer test' },
    });
    await once(socket, 'open');
    socket.send(JSON.stringify(mediaSessionOpen(route)));
    const [decision] = await once(socket, 'message');
    expect(JSON.parse(decision.toString())).toEqual({ type: 'session.accept' });
    await run({ socket, runtime, route, onSessionClose, beforeSessionOpen });
  } finally {
    socket?.terminate();
    await runtime.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('worker media runtime over its authenticated loopback socket', () => {
  it('rejects a direct non-socket media object before composing an engine', async () => {
    const { route, job } = mediaRuntimeFixture();
    const create = vi.fn(async () => ({ dispose: vi.fn(async () => undefined) }));
    const runtime = new WorkerMediaRuntime(
      { workerId: route.workerId },
      { get: vi.fn(async () => job) } as unknown as DurableJobStore,
      { create },
    );
    const forgedMedia = {
      identity: {
        sessionId: route.sessionId,
        ownerEpoch: route.ownerEpoch,
        generation: route.generation,
      },
    };
    const failure = await (
      runtime as unknown as {
        open(media: unknown, selectedRoute: SessionRoute): Promise<void>;
      }
    )
      .open(forgedMedia, route)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(create).not.toHaveBeenCalled();
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('worker media requires an authenticated socket link');
  });

  it.each([
    ['cost-max-duration', 'max_duration'],
    ['worker-shutdown', 'drain'],
    ['media idle deadline exceeded', 'caller_idle'],
    ['owning worker disconnected', 'ownership_lost'],
  ] as const)('passes a typed end reason for %s', async (raw, expected) => {
    const dispose = vi.fn(async () => undefined);
    const create = vi.fn(async () => ({ dispose }));
    await withConnectedSocket({ create }, async ({ socket, route, onSessionClose }) => {
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      socket.send(JSON.stringify({ type: 'session.close', reason: raw }));
      await vi.waitFor(() => expect(dispose).toHaveBeenCalledWith(expected, false));
      expect(onSessionClose).toHaveBeenCalledWith(route, expected);
    });
  });

  it('keeps the requested reason when a close-stream carrier terminates media first', async () => {
    const dispose = vi.fn(async () => undefined);
    const create = vi.fn(async () => ({ dispose }));
    await withConnectedSocket({ create }, async ({ socket, runtime, route, onSessionClose }) => {
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      const ended = once(socket, 'message');
      await runtime.terminate(route.sessionId, 'ownership_lost');
      const [frame] = await ended;
      expect(JSON.parse(frame.toString())).toEqual({ type: 'session.end', reason: 'terminate' });
      expect(dispose).toHaveBeenCalledWith('ownership_lost', false);
      expect(onSessionClose).toHaveBeenCalledWith(route, 'ownership_lost');
    });
  });

  it('opens only the durable owner and disposes on carrier close', async () => {
    const dispose = vi.fn(async () => undefined);
    const create = vi.fn(async (_input: Parameters<VoiceSessionFactory['create']>[0]) => ({
      dispose,
    }));
    await withConnectedSocket({ create }, async ({ socket, route, onSessionClose }) => {
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      expect(create.mock.calls[0]?.[0]).toMatchObject({
        route,
        media: { identity: { sessionId: route.sessionId, ownerEpoch: route.ownerEpoch } },
      });
      socket.send(JSON.stringify({ type: 'session.close', reason: 'carrier stopped' }));
      await vi.waitFor(() => expect(dispose).toHaveBeenCalledWith('caller_hangup', false));
      expect(onSessionClose).toHaveBeenCalledWith(route, 'caller_hangup');
    });
  });

  it('runs admission before composition and closes admitted state on failure', async () => {
    const create = vi.fn(async () => Promise.reject(new Error('composition failed')));
    await withConnectedSocket({ create }, async ({ route, onSessionClose, beforeSessionOpen }) => {
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      expect(beforeSessionOpen).toHaveBeenCalledWith(
        expect.objectContaining({ id: route.jobId }),
        route,
      );
      await vi.waitFor(() =>
        expect(onSessionClose).toHaveBeenCalledWith(
          route,
          'error:session-open-failed:compose:composition failed',
        ),
      );
    });
  });

  // OBS-2: accept is sent before open(), so a failed open used to leave only a bare
  // 'error:session-open-failed' and no log line naming the stage or the cause.
  it('logs and persists the stage and cause of a failed session open', async () => {
    const logs: Record<string, unknown>[] = [];
    const create = vi.fn(async () =>
      Promise.reject(new Error('stt handshake failed: Bearer sk-live-123 rejected (401)')),
    );
    await withConnectedSocket(
      { create },
      async ({ route, onSessionClose }) => {
        const reason =
          'error:session-open-failed:compose:stt handshake failed: Bearer [redacted] rejected (401)';
        await vi.waitFor(() => expect(onSessionClose).toHaveBeenCalledWith(route, reason));
        const failed = logs.find((entry) => entry.event === 'session_open_failed');
        expect(failed).toMatchObject({
          level: 'error',
          workerId: route.workerId,
          sessionId: route.sessionId,
          jobId: route.jobId,
          stage: 'compose',
          error: 'stt handshake failed: Bearer [redacted] rejected (401)',
        });
        expect(JSON.stringify(logs)).not.toContain('sk-live-123');
      },
      { logs },
    );
  });

  it('names admission as the stage when the cost gate refuses the session', async () => {
    const logs: Record<string, unknown>[] = [];
    const create = vi.fn(async () => ({ dispose: vi.fn(async () => undefined) }));
    await withConnectedSocket(
      { create },
      async ({ route, onSessionClose }) => {
        await vi.waitFor(() =>
          expect(onSessionClose).toHaveBeenCalledWith(
            route,
            'error:session-open-failed:admission:inbound cost admission blocked: budget',
          ),
        );
        expect(create).not.toHaveBeenCalled();
        expect(logs.find((entry) => entry.event === 'session_open_failed')).toMatchObject({
          stage: 'admission',
          sessionId: route.sessionId,
        });
      },
      {
        logs,
        beforeSessionOpen: async () => {
          throw new Error('inbound cost admission blocked: budget');
        },
      },
    );
  });

  it('keeps the persisted failure reason on one short line', () => {
    const reason = sessionOpenFailure(
      'record',
      new Error(`line one\n  line two ${'x'.repeat(400)}`),
    );
    expect(reason.startsWith('error:session-open-failed:record:line one line two x')).toBe(true);
    expect(reason.length).toBe('error:session-open-failed:record:'.length + 160);
    expect(sessionOpenFailure('job', 'not an error')).toBe(
      'error:session-open-failed:job:not an error',
    );
  });
});
