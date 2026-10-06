import { vi } from 'vitest';
import type { DurableJob, SessionRoute } from '@winsendotai/ovo-plugin-orchestration';
import type { InboundWorkerRuntime } from '../src/inbound-runtime.ts';
import { runWorkerLoop, type WorkerStatus } from '../src/worker-loop.ts';

/**
 * The real runWorkerLoop over in-memory store, queue, runner, carriers and media. `events` records
 * fence/hangup/media/finalize/close steps in order; the returned controls drive the call.
 * Callers restore env and timers (vi.unstubAllEnvs / vi.useRealTimers) after each test.
 */
export function workerLoopFixture(
  accepted: boolean,
  options: {
    inbound?: boolean;
    terminationFails?: boolean;
    finalizeFails?: boolean;
    blockedDial?: boolean;
    unknownDial?: boolean;
    /** OPS-6 SIGTERM grace; 0 keeps these tests on the terminate-at-once path. */
    drainTimeoutMs?: number;
  } = {},
) {
  vi.stubEnv('OVO_INBOUND_CAPACITY_ENABLED', String(options.inbound ?? false));
  vi.stubEnv('OVO_ORGANIZATION_ID', 'ovo');
  vi.stubEnv('OVO_INBOUND_WARM_FLOOR', '1');
  vi.stubEnv('OVO_MEDIA_GATEWAY_WS_URL', 'ws://gateway.test/worker');
  vi.stubEnv('OVO_MEDIA_WORKER_TOKEN', 'test-token');
  vi.stubEnv('OVO_WORKER_DRAIN_TIMEOUT_MS', String(options.drainTimeoutMs ?? 0));
  const events: string[] = [];
  const status: WorkerStatus = { state: 'starting', detail: '' };
  // Mutable so a test can end the call: endCall() marks it terminal.
  type RouteFixture = Record<string, unknown> & { jobId: string; sessionId: string };
  const route: RouteFixture = {
    sessionId: '00000000-0000-4000-8000-000000000002',
    jobId: '00000000-0000-4000-8000-000000000001',
    workerId: 'worker-1',
    ownerEpoch: 1,
    carrierCallId: 'CA1',
    status: 'accepted',
  };
  const finishCall = vi
    .fn(async () => undefined)
    .mockRejectedValueOnce(new Error('control database unavailable'));
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
    releaseTerminalSession: async () => undefined,
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
    controlStore: { finishCall, close: async () => undefined },
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
    graph: { outcomes: { close: async () => undefined } },
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
    finishCall,
    endCall: () => Object.assign(route, { status: 'completed', terminalAt: new Date() }),
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
        route as unknown as SessionRoute,
      ),
    terminate: (jobId: string, epoch: number, reason: string) => terminate(jobId, epoch, reason),
    shutdown: () => shutdown(),
    completeInbound: () => inbound.completeSession(route.jobId),
    releaseQueue: () => releaseQueue?.([]),
  };
}
