import type {
  DurableJob,
  DurableJobStore,
  SessionRoute,
} from '@winsendotai/ovo-plugin-orchestration';
import type { WorkerMediaSession } from '@winsendotai/ovo-plugin-media';
import { describe, expect, it, vi } from 'vitest';
import { WorkerMediaRuntime, type ManagedVoiceSession } from '../src/media-runtime.ts';

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
  const job: DurableJob = {
    id: route.jobId,
    workspaceId: route.organizationId,
    idempotencyKey: 'job-1',
    payload: {},
    status: 'accepted',
    ownerId: route.workerId,
    ownerEpoch: route.ownerEpoch,
    leaseExpiresAt: new Date(Date.now() + 60_000),
  };
  let closeListener: ((reason: string) => void) | undefined;
  const media = {
    identity: {
      sessionId: route.sessionId,
      callSid: route.carrierCallId,
      streamSid: 'MZ1',
      ownerId: route.workerId,
      ownerEpoch: route.ownerEpoch,
      generation: route.generation,
    },
    onClose(listener: (reason: string) => void) {
      closeListener = listener;
      return () => undefined;
    },
  } as unknown as WorkerMediaSession;
  return { route, job, media, close: (reason: string) => closeListener?.(reason) };
}

describe('worker media runtime', () => {
  it.each([
    ['cost-max-duration', 'max_duration'],
    ['worker-shutdown', 'drain'],
    ['media idle deadline exceeded', 'caller_idle'],
    ['owning worker disconnected', 'ownership_lost'],
  ] as const)('passes a typed end reason for %s', async (raw, expected) => {
    const { route, job, media, close } = fixture();
    const dispose = vi.fn(async () => undefined);
    const runtime = new WorkerMediaRuntime(
      { url: 'ws://127.0.0.1:1/worker', workerId: route.workerId, token: 'test' },
      {
        resolveSessionRoute: vi.fn(async () => route),
        get: vi.fn(async () => job),
      } as unknown as DurableJobStore,
      { create: async () => ({ dispose }) },
    );
    await open(runtime, media);
    close(raw);
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledWith(expected, false));
  });

  it('keeps the requested reason when a close-stream carrier terminates media first', async () => {
    const { route, job, media } = fixture();
    const dispose = vi.fn(async () => undefined);
    const runtime = new WorkerMediaRuntime(
      { url: 'ws://127.0.0.1:1/worker', workerId: route.workerId, token: 'test' },
      {
        resolveSessionRoute: vi.fn(async () => route),
        get: vi.fn(async () => job),
      } as unknown as DurableJobStore,
      { create: async () => ({ dispose }) },
    );
    await open(runtime, media);
    await runtime.terminate(route.sessionId, 'ownership_lost');
    expect(dispose).toHaveBeenCalledWith('ownership_lost');
  });

  it('opens media only for the current durable owner and disposes on carrier close', async () => {
    const { route, job, media, close } = fixture();
    const dispose = vi.fn(async () => undefined);
    const onSessionClose = vi.fn(async () => undefined);
    const factory = { create: vi.fn(async () => ({ dispose }) as ManagedVoiceSession) };
    const runtime = new WorkerMediaRuntime(
      { url: 'ws://127.0.0.1:1/worker', workerId: route.workerId, token: 'test' },
      {
        resolveSessionRoute: vi.fn(async () => route),
        get: vi.fn(async () => job),
      } as unknown as DurableJobStore,
      factory,
      onSessionClose,
    );

    await open(runtime, media);
    expect(factory.create).toHaveBeenCalledWith({ job, route, media });
    close('carrier stopped');
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledWith('caller_hangup', false));
    await vi.waitFor(() => expect(onSessionClose).toHaveBeenCalledWith(route, 'caller_hangup'));
  });

  it.each([
    ['sessionId', 'stale-session'],
    ['ownerEpoch', 6],
    ['generation', 1],
  ] as const)('rejects a stale %s before creating an engine', async (field, value) => {
    const { route, job, media } = fixture();
    Object.assign(media.identity, { [field]: value });
    const factory = { create: vi.fn() };
    const runtime = new WorkerMediaRuntime(
      { url: 'ws://127.0.0.1:1/worker', workerId: route.workerId, token: 'test' },
      {
        resolveSessionRoute: vi.fn(async () => route),
        get: vi.fn(async () => job),
      } as unknown as DurableJobStore,
      factory,
    );

    await expect(open(runtime, media)).rejects.toThrow('durable route identity');
    expect(factory.create).not.toHaveBeenCalled();
  });

  it('runs admission before composition and closes admitted state when composition fails', async () => {
    const { route, job, media } = fixture();
    const beforeSessionOpen = vi.fn(async () => undefined);
    const onSessionClose = vi.fn(async () => undefined);
    const runtime = new WorkerMediaRuntime(
      { url: 'ws://127.0.0.1:1/worker', workerId: route.workerId, token: 'test' },
      {
        resolveSessionRoute: vi.fn(async () => route),
        get: vi.fn(async () => job),
      } as unknown as DurableJobStore,
      { create: vi.fn(async () => Promise.reject(new Error('composition failed'))) },
      onSessionClose,
      beforeSessionOpen,
    );

    await expect(open(runtime, media)).rejects.toThrow('composition failed');
    expect(beforeSessionOpen).toHaveBeenCalledWith(job, route);
    expect(onSessionClose).toHaveBeenCalledWith(route, 'error:session-open-failed');
  });
});

function open(runtime: WorkerMediaRuntime, media: WorkerMediaSession): Promise<void> {
  return (runtime as unknown as { open(session: WorkerMediaSession): Promise<void> }).open(media);
}
