import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DurableJob, SessionRoute } from '@winsendotai/ovo-plugin-orchestration';
import type { InboundWorkerRuntime } from '../src/inbound-runtime.ts';
import { runWorkerLoop, type WorkerStatus } from '../src/worker-loop.ts';

describe('runWorkerLoop forced exit cost settlement', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  function fixture(
    accepted: boolean,
    options: {
      inbound?: boolean;
      terminationFails?: boolean;
      finalizeFails?: boolean;
      blockedDial?: boolean;
      unknownDial?: boolean;
    } = {},
  ) {
    vi.stubEnv('OVO_INBOUND_CAPACITY_ENABLED', String(options.inbound ?? false));
    vi.stubEnv('OVO_ORGANIZATION_ID', 'ovo');
    vi.stubEnv('OVO_INBOUND_WARM_FLOOR', '1');
    vi.stubEnv('OVO_MEDIA_GATEWAY_WS_URL', 'ws://gateway.test/worker');
    vi.stubEnv('OVO_MEDIA_WORKER_TOKEN', 'test-token');
    const events: string[] = [];
    const status: WorkerStatus = { state: 'starting', detail: '' };
    const route = {
      sessionId: '00000000-0000-4000-8000-000000000002',
      jobId: '00000000-0000-4000-8000-000000000001',
      workerId: 'worker-1',
      ownerEpoch: 1,
      carrierCallId: 'CA1',
      status: 'accepted',
    };
    let shutdown!: () => void;
    let terminate!: (jobId: string, epoch: number, reason: string) => Promise<boolean>;
    let releaseQueue!: (messages: unknown[]) => void;
    let deliveries = 0;
    let inbound!: InboundWorkerRuntime;
    let releaseDial!: () => void;
    const reports: string[] = [];
    const gate = options.blockedDial
      ? new Promise<void>((resolve) => {
          releaseDial = resolve;
        })
      : undefined;
    const finalize = vi.fn(async () => {
      events.push('finalize');
      if (options.finalizeFails) throw new Error('cost ledger unavailable');
    });
    const stopLease = vi.fn();
    const releaseProtection = vi.fn(async () => undefined);
    const media = {
      start: async () => undefined,
      terminate: async () => {
        events.push('media');
      },
      closeSession: async () => {
        events.push('close-session');
      },
      close: async () => {
        events.push('media-close');
      },
    };
    const store = {
      reportWorker: async (row: { state: string }) => {
        reports.push(row.state);
        return true;
      },
      claimInboundFloorToken: async () => true,
      releaseInboundFloorToken: async () => {
        events.push('floor-release');
        return true;
      },
      get: async () => ({ id: route.jobId, workspaceId: 'ws-1', payload: {} }),
      getSessionRoute: async () => route,
      requestSessionTermination: async () => {
        events.push('fence');
        return { carrierCallId: 'CA1' };
      },
    };
    const runner = {
      beginDrain: vi.fn(),
      setTerminationHandler(handler: typeof terminate) {
        terminate = handler;
      },
      handle: async () => {
        await gate;
        if (options.unknownDial)
          return {
            kind: 'reconcile_required' as const,
            jobId: route.jobId,
            requestId: 'request-1',
          };
        return {
          kind: 'accepted' as const,
          jobId: route.jobId,
          sessionId: route.sessionId,
          carrierCallId: 'CA1',
          lease: { ownerEpoch: 1, stop: stopLease },
          protection: { release: releaseProtection },
        };
      },
    };
    const queue = {
      receive: async () => {
        if (accepted && deliveries++ === 0)
          return [
            {
              messageId: 'hint',
              receiptHandle: 'receipt',
              receiveCount: 1,
              reference: { schemaVersion: 1, jobId: route.jobId },
            },
          ];
        return new Promise<unknown[]>((resolve) => {
          releaseQueue = resolve;
        });
      },
    };
    const runtime = {
      kind: 'ready',
      workerId: 'worker-1',
      workerEpoch: 1,
      workerEndpoint: 'ws://worker.test:4100/internal/media',
      store,
      queue,
      runner,
      telephony: {},
      protection: {
        establish: async () => true,
        renew: async () => true,
        release: async () => {
          events.push('protection-release');
        },
      },
      operations: { inbound: { registerProtectedCapacity: async () => true } },
      costs: {
        finalize,
        setTerminationHandler: vi.fn(),
        reserve: async () => ({ admitted: true, beginActiveCall: vi.fn() }),
      },
      recordings: { live: {} },
      controlStore: { close: async () => undefined },
      costLedger: { close: async () => undefined },
      telemetry: { close: async () => undefined },
      secrets: {},
      speechCache: { close: vi.fn() },
      extensions: {},
      composition: {
        dispose: async () => {
          events.push('composition-close');
        },
      },
      distribution: {},
      carriers: {
        forJob: async () => {
          if (options.terminationFails) throw new Error('selected carrier unavailable');
          return {
            control: {
              hangup: async () => {
                events.push('hangup');
                return 'ended';
              },
            },
            carrier: { capabilities: { control: { hangup: 'close-stream' } } },
          };
        },
      },
    };
    const running = runWorkerLoop({
      status,
      server: { close: vi.fn() } as never,
      openProcess: async () => runtime as never,
      createMedia: (input) => {
        inbound = input.inbound!;
        return media as never;
      },
      registerShutdown: (handler) => {
        shutdown = handler;
      },
    });
    return {
      running,
      status,
      events,
      finalize,
      reports,
      stopLease,
      releaseProtection,
      releaseDial: () => releaseDial(),
      admit: () =>
        inbound.admitSession(
          {
            id: route.jobId,
            workspaceId: 'ws-1',
            idempotencyKey: 'inbound-1',
            payload: { kind: 'inbound_call' },
            status: 'accepted',
            ownerId: 'worker-1',
            ownerEpoch: 1,
          } satisfies DurableJob,
          route as SessionRoute,
        ),
      terminate: (jobId: string, epoch: number, reason: string) => terminate(jobId, epoch, reason),
      shutdown: () => shutdown(),
      releaseQueue: () => releaseQueue?.([]),
    };
  }

  it('finalizes cost after the real loop termination callback handles lease loss', async () => {
    const subject = fixture(false);
    await vi.waitFor(() => expect(subject.status.state).toBe('ready'));
    await subject.terminate('00000000-0000-4000-8000-000000000001', 1, 'job-lease-lost');
    expect(subject.events.slice(0, 5)).toEqual([
      'fence',
      'hangup',
      'media',
      'close-session',
      'finalize',
    ]);
    expect(subject.finalize).toHaveBeenCalledOnce();
    subject.shutdown();
    subject.releaseQueue();
    await subject.running;
  });

  it.each([false, true])(
    'releases inbound session state after forced job lease loss (termination fails: %s)',
    async (terminationFails) => {
      const subject = fixture(false, { inbound: true, terminationFails });
      await vi.waitFor(() => expect(subject.status.state).toBe('ready'));
      await subject.admit();
      expect(subject.status.state).toBe('active');

      if (terminationFails)
        await expect(
          subject.terminate('00000000-0000-4000-8000-000000000001', 1, 'job-lease-lost'),
        ).rejects.toThrow('selected carrier unavailable');
      else await subject.terminate('00000000-0000-4000-8000-000000000001', 1, 'job-lease-lost');
      await vi.waitFor(() => expect(subject.status.state).toBe('ready'));
      expect(subject.status.detail).toBe('Inbound session closed');
      expect(subject.events.slice(0, terminationFails ? 4 : 5)).toEqual([
        'floor-release',
        'fence',
        ...(terminationFails ? [] : ['hangup']),
        'media',
        'close-session',
      ]);
      subject.shutdown();
      subject.releaseQueue();
      await subject.running;
    },
  );

  it.each(['none', 'termination', 'finalization'])(
    'closes outbound shutdown resources despite %s failure',
    async (failure) => {
      const terminationFails = failure === 'termination';
      const subject = fixture(true, {
        terminationFails,
        finalizeFails: failure === 'finalization',
      });
      await vi.waitFor(() => expect(subject.status.state).toBe('active'));
      subject.status.state = 'draining';
      await subject.running.catch(() => undefined);
      expect(subject.events).toEqual([
        'fence',
        ...(terminationFails ? [] : ['hangup']),
        'media',
        'close-session',
        'finalize',
        'media-close',
        'composition-close',
      ]);
      expect(subject.finalize).toHaveBeenCalledOnce();
      expect(subject.stopLease).toHaveBeenCalledOnce();
      expect(subject.releaseProtection).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    'finalizes active inbound shutdown before protection release (termination fails: %s)',
    async (terminationFails) => {
      const subject = fixture(false, { inbound: true, terminationFails });
      await vi.waitFor(() => expect(subject.status.state).toBe('ready'));
      await subject.admit();
      subject.events.length = 0;
      subject.shutdown();
      subject.releaseQueue();
      await subject.running;
      expect(subject.events).toEqual([
        'fence',
        ...(terminationFails ? [] : ['hangup']),
        'media',
        'close-session',
        'finalize',
        'protection-release',
        'media-close',
        'composition-close',
      ]);
      expect(subject.finalize).toHaveBeenCalledOnce();
      if (terminationFails) expect(subject.status.detail).toContain('selected carrier unavailable');
    },
  );

  it('keeps periodic reports reserved throughout a blocked outbound dial', async () => {
    vi.useFakeTimers();
    const subject = fixture(true, { blockedDial: true });
    await vi.waitFor(() => expect(subject.reports).toContain('reserved'));
    await vi.advanceTimersByTimeAsync(10_000);
    const reportsWhileDialing = [...subject.reports];
    subject.releaseDial();
    await vi.waitFor(() => expect(subject.status.state).toBe('active'));
    subject.shutdown();
    await vi.advanceTimersByTimeAsync(1_000);
    await subject.running;
    expect(reportsWhileDialing).toEqual(['ready_idle', 'reserved', 'reserved', 'reserved']);
    expect(subject.reports).toContain('active');
    expect(subject.reports.at(-1)).toBe('draining');
  });
  it.each([false, true])(
    'waits for an in-flight dial on shutdown (unknown outcome: %s)',
    async (unknownDial) => {
      vi.useFakeTimers();
      const subject = fixture(true, { blockedDial: true, unknownDial });
      await vi.waitFor(() => expect(subject.reports).toContain('reserved'));
      subject.shutdown();
      await vi.advanceTimersByTimeAsync(1);
      const beforeDialSettles = [...subject.events];
      subject.releaseDial();
      await vi.advanceTimersByTimeAsync(1_000);
      const stateAfterDialSettles = subject.status.state;
      if (stateAfterDialSettles !== 'draining') subject.status.state = 'draining';
      subject.releaseQueue();
      await vi.advanceTimersByTimeAsync(1_000);
      await subject.running;
      expect(beforeDialSettles).toEqual([]);
      expect(stateAfterDialSettles).toBe('draining');
      expect(subject.events).toEqual([
        ...(unknownDial ? [] : ['fence', 'hangup', 'media', 'close-session', 'finalize']),
        'media-close',
        'composition-close',
      ]);
      expect(subject.finalize).toHaveBeenCalledTimes(unknownDial ? 0 : 1);
      expect(subject.reports).not.toContain('active');
    },
  );
});
