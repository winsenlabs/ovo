import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DurableJob, SessionRoute } from '@winsendotai/ovo-plugin-orchestration';
import { InboundWorkerRuntime } from '../src/inbound-runtime.ts';
import { runWorkerLoop, type WorkerStatus } from '../src/worker-loop.ts';

function fixture() {
  const registerProtectedCapacity = vi.fn(async () => true);
  const suspendProtectedCapacity = vi.fn(async () => true);
  const claimInboundFloorToken = vi.fn(async () => true);
  const releaseInboundFloorToken = vi.fn(async () => true);
  const protection = {
    establish: vi.fn(async () => true),
    renew: vi.fn(async () => true),
    release: vi.fn(async () => undefined),
  };
  const requestSessionTermination = vi.fn(async () => ({ carrierCallId: 'CA1' }));
  const heartbeat = vi.fn(
    async (_jobId: string, _workerId: string, _epoch: number, _leaseMs: number) => true,
  );
  const hangup = vi.fn(async () => undefined);
  const costs = { reserve: vi.fn() };
  const onProtectionLost = vi.fn();
  const onSessionIdle = vi.fn();
  const runtime = new InboundWorkerRuntime({
    workerId: 'worker-1',
    workerEndpoint: 'worker://worker-1',
    generation: 42,
    organizationId: 'ovo',
    inboundWarmFloor: 2,
    floor: { claimInboundFloorToken, releaseInboundFloorToken },
    protection,
    operations: { inbound: { registerProtectedCapacity, suspendProtectedCapacity } } as never,
    store: { heartbeat, requestSessionTermination } as never,
    telephony: { hangup } as never,
    costs: costs as never,
    onProtectionLost,
    onSessionIdle,
  });
  return {
    runtime,
    protection,
    registerProtectedCapacity,
    suspendProtectedCapacity,
    claimInboundFloorToken,
    releaseInboundFloorToken,
    requestSessionTermination,
    heartbeat,
    hangup,
    costs,
    onProtectionLost,
    onSessionIdle,
  };
}

const inboundJob = {
  id: 'job-1',
  workspaceId: 'workspace-1',
  idempotencyKey: 'inbound-1',
  payload: { kind: 'inbound_call' },
  status: 'accepted',
  ownerId: 'worker-1',
  ownerEpoch: 42,
  leaseExpiresAt: new Date(Date.now() + 60_000),
} satisfies DurableJob;

const route = {
  sessionId: 'session-1',
  jobId: 'job-1',
  organizationId: 'ovo',
  workerId: 'worker-1',
  workerEndpoint: 'worker://worker-1',
  ownerEpoch: 42,
  generation: 42,
  dialRequestId: 'inbound:slot:receipt',
  carrierCallId: 'CA1',
  status: 'accepted',
  handshakeExpiresAt: new Date(Date.now() + 60_000),
} satisfies SessionRoute;

describe('InboundWorkerRuntime', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it('does not hang up an inbound leg before its ownership fence resolves', async () => {
    const subject = fixture();
    subject.costs.reserve.mockResolvedValue({ admitted: true, beginActiveCall: vi.fn() });
    await subject.runtime.admitSession(inboundJob, route);
    let releaseFence!: () => void;
    subject.requestSessionTermination.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseFence = () => resolve({ carrierCallId: 'CA1' });
        }),
    );
    const failing = (
      subject.runtime as unknown as { failClosed(reason: string): Promise<void> }
    ).failClosed('ownership lost');
    await vi.waitFor(() => expect(subject.requestSessionTermination).toHaveBeenCalledOnce());
    expect(subject.hangup).not.toHaveBeenCalled();
    releaseFence();
    await failing;
    expect(subject.hangup).toHaveBeenCalledWith('CA1');
  });

  it('advertises only protected capacity and atomically suspends it for outbound work', async () => {
    const subject = fixture();
    await subject.runtime.start();
    expect(subject.protection.establish).toHaveBeenCalledOnce();
    expect(subject.registerProtectedCapacity).toHaveBeenLastCalledWith(
      expect.objectContaining({ ready: true, generation: 42 }),
    );

    await expect(subject.runtime.suspendForOutbound()).resolves.toBe(true);
    expect(subject.suspendProtectedCapacity).toHaveBeenCalledWith({
      slotId: 'worker-1:inbound',
      workerId: 'worker-1',
      generation: 42,
    });
    await subject.runtime.resume();
    expect(subject.protection.establish).toHaveBeenCalledTimes(2);

    await subject.runtime.close();
    expect(subject.registerProtectedCapacity).toHaveBeenLastCalledWith(
      expect.objectContaining({ ready: false }),
    );
    expect(subject.protection.release).toHaveBeenCalledTimes(2);
  });

  it('leaves workers without a floor token unprotected and retries after outbound work', async () => {
    const subject = fixture();
    subject.claimInboundFloorToken.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await subject.runtime.start();
    expect(subject.protection.establish).not.toHaveBeenCalled();
    expect(subject.registerProtectedCapacity).toHaveBeenLastCalledWith(
      expect.objectContaining({ ready: false }),
    );
    await expect(subject.runtime.suspendForOutbound()).resolves.toBe(true);
    expect(subject.suspendProtectedCapacity).not.toHaveBeenCalled();
    await subject.runtime.resume();
    expect(subject.protection.establish).toHaveBeenCalledOnce();
    expect(subject.registerProtectedCapacity).toHaveBeenLastCalledWith(
      expect.objectContaining({ ready: true }),
    );
    await subject.runtime.close();
  });

  it('releases a floor token while an inbound call is active and reclaims it before advertising idle', async () => {
    const subject = fixture();
    subject.costs.reserve.mockResolvedValue({ admitted: true, beginActiveCall: vi.fn() });
    await subject.runtime.start();
    await subject.runtime.admitSession(inboundJob, route);
    expect(subject.releaseInboundFloorToken).toHaveBeenCalledOnce();
    expect(subject.registerProtectedCapacity).toHaveBeenLastCalledWith(
      expect.objectContaining({ ready: false }),
    );
    await expect(subject.runtime.suspendForOutbound()).resolves.toBe(false);
    subject.runtime.completeSession(inboundJob.id);
    await vi.waitFor(() => expect(subject.protection.establish).toHaveBeenCalledTimes(2));
    expect(subject.registerProtectedCapacity).toHaveBeenLastCalledWith(
      expect.objectContaining({ ready: true }),
    );
    await subject.runtime.close();
  });

  it('keeps the worker drained when protection cannot be restored after an inbound call', async () => {
    const subject = fixture();
    subject.protection.establish.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    subject.costs.reserve.mockResolvedValue({ admitted: true, beginActiveCall: vi.fn() });
    await subject.runtime.start();
    await subject.runtime.admitSession(inboundJob, route);
    subject.runtime.completeSession(inboundJob.id);
    await vi.waitFor(() => expect(subject.onProtectionLost).toHaveBeenCalledWith(
      'failed to re-establish inbound task protection',
    ));
    expect(subject.onSessionIdle).not.toHaveBeenCalled();
  });

  it('starts admitted inbound cost timing before composition', async () => {
    const subject = fixture();
    const beginActiveCall = vi.fn();
    subject.costs.reserve.mockResolvedValue({ admitted: true, beginActiveCall });
    await subject.runtime.admitSession(inboundJob, route);
    expect(beginActiveCall).toHaveBeenCalledOnce();
    expect(subject.hangup).not.toHaveBeenCalled();
  });

  it('renews active inbound job ownership beyond the initial protection window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T17:00:00.000Z'));
    const subject = fixture();
    const initialLeaseExpiry = Date.now() + 120_000;
    let leaseExpiry = initialLeaseExpiry;
    subject.heartbeat.mockImplementation(async (_jobId, _workerId, _epoch, leaseMs) => {
      if (Date.now() >= leaseExpiry) return false;
      leaseExpiry = Date.now() + leaseMs;
      return true;
    });
    subject.costs.reserve.mockResolvedValue({ admitted: true, beginActiveCall: vi.fn() });

    await subject.runtime.start();
    await subject.runtime.admitSession(inboundJob, route);
    await vi.advanceTimersByTimeAsync(135_000);

    expect(Date.now()).toBeGreaterThan(initialLeaseExpiry);
    expect(leaseExpiry).toBeGreaterThan(Date.now());
    expect(subject.heartbeat).toHaveBeenCalledTimes(3);
    expect(subject.heartbeat).toHaveBeenLastCalledWith('job-1', 'worker-1', 42, 120_000);
    expect(subject.onProtectionLost).not.toHaveBeenCalled();
    expect(subject.hangup).not.toHaveBeenCalled();
    await subject.runtime.close();
  });

  it('terminates the carrier leg and drains when active job ownership is fenced', async () => {
    vi.useFakeTimers();
    const subject = fixture();
    subject.heartbeat.mockResolvedValue(false);
    subject.costs.reserve.mockResolvedValue({ admitted: true, beginActiveCall: vi.fn() });

    await subject.runtime.start();
    await subject.runtime.admitSession(inboundJob, route);
    await vi.advanceTimersByTimeAsync(45_000);

    expect(subject.onProtectionLost).toHaveBeenCalledWith('inbound job lease renewal was fenced');
    expect(subject.requestSessionTermination).toHaveBeenCalledWith(
      'job-1',
      'worker-1',
      42,
      'inbound job lease renewal was fenced',
    );
    expect(subject.hangup).toHaveBeenCalledWith('CA1');
    subject.runtime.completeSession('job-1');
    expect(subject.onSessionIdle).not.toHaveBeenCalled();
    expect(subject.registerProtectedCapacity).toHaveBeenLastCalledWith(
      expect.objectContaining({ ready: false }),
    );
    await subject.runtime.close();
  });

  it('terminates the carrier leg and drains when the ownership store is unavailable', async () => {
    vi.useFakeTimers();
    const subject = fixture();
    subject.heartbeat.mockRejectedValue(new Error('database offline'));
    subject.costs.reserve.mockResolvedValue({ admitted: true, beginActiveCall: vi.fn() });

    await subject.runtime.start();
    await subject.runtime.admitSession(inboundJob, route);
    await vi.advanceTimersByTimeAsync(45_000);

    const reason = 'inbound job lease renewal unavailable: database offline';
    expect(subject.onProtectionLost).toHaveBeenCalledWith(reason);
    expect(subject.requestSessionTermination).toHaveBeenCalledWith('job-1', 'worker-1', 42, reason);
    expect(subject.hangup).toHaveBeenCalledWith('CA1');
    await subject.runtime.close();
  });

  it('terminates an active carrier leg when task protection is lost', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T00:00:00.000Z'));
    const subject = fixture();
    subject.protection.renew.mockResolvedValue(false);
    subject.costs.reserve.mockResolvedValue({ admitted: true, beginActiveCall: vi.fn() });

    await subject.runtime.start();
    await subject.runtime.admitSession(inboundJob, route);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(subject.onProtectionLost).not.toHaveBeenCalled();
    expect(subject.heartbeat).toHaveBeenCalled();
    vi.setSystemTime(new Date('2026-09-25T00:56:00.000Z'));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(subject.onProtectionLost).toHaveBeenCalledWith('inbound task protection renewal failed');
    expect(subject.hangup).toHaveBeenCalledWith('CA1');
    await subject.runtime.close();
  });

  it('terminates and hangs up an inbound call blocked by cost admission', async () => {
    const subject = fixture();
    subject.costs.reserve.mockResolvedValue({ admitted: false, reason: 'budget exceeded' });
    await expect(subject.runtime.admitSession(inboundJob, route)).rejects.toThrow(
      'inbound cost admission blocked: budget exceeded',
    );
    expect(subject.requestSessionTermination).toHaveBeenCalledWith(
      'job-1',
      'worker-1',
      42,
      'inbound cost admission blocked: budget exceeded',
    );
    expect(subject.hangup).toHaveBeenCalledWith('CA1');
  });
});

describe('runWorkerLoop forced exit cost settlement', () => {
  afterEach(() => vi.unstubAllEnvs());

  function fixture(accepted: boolean) {
    vi.stubEnv('OVO_INBOUND_CAPACITY_ENABLED', 'false');
    vi.stubEnv('OVO_MEDIA_GATEWAY_WS_URL', 'ws://gateway.test/worker');
    vi.stubEnv('OVO_MEDIA_WORKER_TOKEN', 'test-token');
    const events: string[] = [];
    const status: WorkerStatus = { state: 'starting', detail: '' };
    const route = {
      sessionId: '00000000-0000-4000-8000-000000000002',
      jobId: '00000000-0000-4000-8000-000000000001',
      workerId: 'worker-1', ownerEpoch: 1, carrierCallId: 'CA1', status: 'accepted',
    };
    let shutdown!: () => void;
    let terminate!: (jobId: string, epoch: number, reason: string) => Promise<boolean>;
    let releaseQueue!: (messages: unknown[]) => void;
    let deliveries = 0;
    const finalize = vi.fn(async () => { events.push('finalize'); });
    const media = {
      start: async () => undefined,
      terminate: async () => { events.push('media'); },
      closeSession: async () => { events.push('close-session'); },
      close: async () => { events.push('media-close'); },
    };
    const store = {
      reportWorker: async () => true,
      get: async () => ({ id: route.jobId, workspaceId: 'ws-1', payload: {} }),
      getSessionRoute: async () => route,
      requestSessionTermination: async () => { events.push('fence'); return { carrierCallId: 'CA1' }; },
    };
    const runner = {
      beginDrain: vi.fn(),
      setTerminationHandler(handler: typeof terminate) { terminate = handler; },
      handle: async () => ({
        kind: 'accepted' as const, jobId: route.jobId, sessionId: route.sessionId,
        carrierCallId: 'CA1', lease: { ownerEpoch: 1, stop: vi.fn() },
        protection: { release: vi.fn(async () => undefined) },
      }),
    };
    const queue = {
      receive: async () => {
        if (accepted && deliveries++ === 0)
          return [{ messageId: 'hint', receiptHandle: 'receipt', receiveCount: 1,
            reference: { schemaVersion: 1, jobId: route.jobId } }];
        return new Promise<unknown[]>((resolve) => { releaseQueue = resolve; });
      },
    };
    const runtime = {
      kind: 'ready', workerId: 'worker-1', workerEpoch: 1,
      workerEndpoint: 'ws://worker.test:4100/internal/media',
      store, queue, runner, telephony: {}, protection: {}, operations: {},
      costs: { finalize, setTerminationHandler: vi.fn() },
      recordings: { live: {} }, controlStore: { close: async () => undefined },
      costLedger: { close: async () => undefined }, telemetry: { close: async () => undefined },
      secrets: {}, speechCache: { close: vi.fn() }, extensions: {},
      composition: { dispose: async () => undefined }, distribution: {},
      carriers: { forJob: async () => ({
        control: { hangup: async () => { events.push('hangup'); return 'ended'; } },
        carrier: { capabilities: { control: { hangup: 'close-stream' } } },
      }) },
    };
    const running = runWorkerLoop({
      status, server: { close: vi.fn() } as never,
      openProcess: async () => runtime as never,
      createMedia: () => media as never,
      registerShutdown: (handler) => { shutdown = handler; },
    });
    return {
      running, status, events, finalize,
      terminate: (jobId: string, epoch: number, reason: string) => terminate(jobId, epoch, reason),
      shutdown: () => shutdown(),
      releaseQueue: () => releaseQueue?.([]),
    };
  }

  it('finalizes cost after the real loop termination callback handles lease loss', async () => {
    const subject = fixture(false);
    await vi.waitFor(() => expect(subject.status.state).toBe('ready'));
    await subject.terminate('00000000-0000-4000-8000-000000000001', 1, 'job-lease-lost');
    expect(subject.events.slice(0, 5)).toEqual(['fence', 'hangup', 'media', 'close-session', 'finalize']);
    expect(subject.finalize).toHaveBeenCalledOnce();
    subject.shutdown();
    subject.releaseQueue();
    await subject.running;
  });

  it('finalizes cost exactly once after the active route is terminated on shutdown', async () => {
    const subject = fixture(true);
    await vi.waitFor(() => expect(subject.status.state).toBe('active'));
    subject.shutdown();
    await vi.waitFor(() => expect(subject.finalize).toHaveBeenCalledOnce());
    expect(subject.events.slice(0, 5)).toEqual(['fence', 'hangup', 'media', 'close-session', 'finalize']);
    await subject.running;
  });
});
