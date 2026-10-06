import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Reconciliation } from '@winsendotai/ovo-contracts';
import { PostgresOrchestrationStore } from '@winsendotai/ovo-plugin-orchestration';
import { reconcileTerminalRoute, terminateOwnedJob } from '../src/worker-termination.ts';

const ended = (state: 'completed' | 'busy' | 'canceled'): Reconciliation => ({
  kind: 'ended',
  state,
});

function fakeStore(route: Record<string, unknown> | undefined, applied = 'applied') {
  return {
    getSessionRoute: vi.fn(async () => route),
    applyCarrierCallback: vi.fn(async () => ({ kind: applied, route })),
  };
}

const live = {
  jobId: 'job-1',
  organizationId: 'org-1',
  carrierId: 'fixture',
  carrierCallId: 'CA1',
  dialRequestId: 'job-1:1',
};

describe('terminal status reconcile (OBS-11)', () => {
  it('records an ended carrier call as a reconcile callback and releases capacity', async () => {
    const store = fakeStore(live);
    const control = { reconcile: vi.fn(async () => ended('canceled')) };
    const onTerminal = vi.fn(async () => undefined);
    expect(
      await reconcileTerminalRoute(
        { jobId: 'job-1', store: store as never, control },
        { onTerminal },
      ),
    ).toBe('applied');
    expect(control.reconcile).toHaveBeenCalledWith({ requestId: 'job-1:1', carrierCallId: 'CA1' });
    expect(store.applyCarrierCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        carrierId: 'fixture',
        provider: 'ovo.reconcile',
        eventId: 'CA1:reconcile:cancelled',
        status: 'cancelled',
      }),
    );
    expect(onTerminal).toHaveBeenCalledWith({ carrierCallId: 'CA1', status: 'cancelled' });
  });

  it('leaves a route the real callback already ended, a live call, and an unknown call alone', async () => {
    const control = { reconcile: vi.fn(async () => ended('completed')) };
    const terminal = fakeStore({ ...live, terminalAt: new Date() });
    expect(await reconcileTerminalRoute({ jobId: 'j', store: terminal as never, control })).toBe(
      'already_terminal',
    );
    expect(control.reconcile).not.toHaveBeenCalled();
    const ringing = {
      reconcile: async (): Promise<Reconciliation> => ({ kind: 'live', state: 'in_progress' }),
    };
    const open = fakeStore(live);
    expect(
      await reconcileTerminalRoute({ jobId: 'j', store: open as never, control: ringing }),
    ).toBe('not_ended');
    expect(open.applyCarrierCallback).not.toHaveBeenCalled();
    const anonymous = fakeStore({ ...live, carrierCallId: undefined });
    expect(await reconcileTerminalRoute({ jobId: 'j', store: anonymous as never, control })).toBe(
      'unidentified',
    );
  });

  it('does not run onTerminal when the store ordered the callback out', async () => {
    const onTerminal = vi.fn();
    const store = fakeStore(live, 'ignored_out_of_order');
    const control = { reconcile: async () => ended('busy') };
    expect(
      await reconcileTerminalRoute({ jobId: 'j', store: store as never, control }, { onTerminal }),
    ).toBe('already_terminal');
    expect(onTerminal).not.toHaveBeenCalled();
  });

  it('schedules the check after terminating the carrier leg only when asked', async () => {
    vi.useFakeTimers();
    try {
      const reconcile = vi.fn(async () => ended('completed'));
      const input = (withReconcile: boolean) => ({
        jobId: 'job-1',
        workerId: 'worker-1',
        ownerEpoch: 1,
        reason: 'caller_hangup',
        store: {
          get: async () => ({ id: 'job-1', payload: {} }),
          getSessionRoute: async () => ({
            ...live,
            sessionId: 's1',
            workerId: 'worker-1',
            ownerEpoch: 1,
          }),
          requestSessionTermination: async () => ({ carrierCallId: 'CA1' }),
          applyCarrierCallback: async () => ({ kind: 'applied' }),
        } as never,
        carriers: {
          forJob: async () => ({
            control: { hangup: async () => 'ended', reconcile },
            carrier: { capabilities: { control: { hangup: 'rest' } } },
          }),
        } as never,
        media: { terminate: async () => undefined, closeSession: async () => undefined } as never,
        ...(withReconcile ? { reconcile: { afterMs: 1_000 } } : {}),
      });
      await terminateOwnedJob(input(false));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(reconcile).not.toHaveBeenCalled();
      await terminateOwnedJob(input(true));
      await vi.advanceTimersByTimeAsync(999);
      expect(reconcile).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(reconcile).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe.skipIf(!process.env.OVO_TEST_POSTGRES_URL)('terminal reconcile on a durable route', () => {
  const schema = `obs11_reconcile_${randomUUID().replaceAll('-', '')}`;
  let admin: PostgresOrchestrationStore;
  let store: PostgresOrchestrationStore;

  beforeAll(async () => {
    admin = new PostgresOrchestrationStore({ connectionString: process.env.OVO_TEST_POSTGRES_URL });
    await admin.pool.query(`CREATE SCHEMA ${schema}`);
    store = new PostgresOrchestrationStore({
      connectionString: process.env.OVO_TEST_POSTGRES_URL,
      options: `-c search_path=${schema}`,
    });
    await store.migrate();
  });

  afterAll(async () => {
    await store?.close();
    if (admin) {
      await admin.pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.close();
    }
  });

  it('ends a terminating route with no terminal callback, once', async () => {
    const jobId = randomUUID();
    await store.enqueue({ id: jobId, workspaceId: schema, idempotencyKey: jobId, payload: {} });
    const claimed = await store.claim(jobId, 'worker-1', 60_000);
    if (claimed.kind !== 'execute') throw new Error('expected claim');
    const epoch = claimed.job.ownerEpoch;
    await store.beginDialSession({
      sessionId: randomUUID(),
      jobId,
      organizationId: schema,
      workerId: 'worker-1',
      workerEndpoint: 'ws://worker.test:4100/internal/media',
      ownerEpoch: epoch,
      generation: 1,
      dialRequestId: `${jobId}:1`,
      carrierId: 'fixture',
      handshakeTokenHash: 'test-hash',
      handshakeExpiresAt: new Date(Date.now() + 60_000),
    });
    await store.markDialAccepted({
      jobId,
      workerId: 'worker-1',
      ownerEpoch: epoch,
      dialRequestId: `${jobId}:1`,
      carrierCallId: `CA-${jobId}`,
    });
    await store.requestSessionTermination(jobId, 'worker-1', epoch, 'caller_hangup');
    expect((await store.getSessionRoute(jobId))?.status).toBe('terminating');
    const control = { reconcile: vi.fn(async () => ended('completed')) };
    const onTerminal = vi.fn(async () => undefined);
    expect(await reconcileTerminalRoute({ jobId, store, control }, { onTerminal })).toBe('applied');
    const route = await store.getSessionRoute(jobId);
    expect(route).toMatchObject({ status: 'completed', terminalReason: 'caller_hangup' });
    expect(route?.terminalAt).toBeDefined();
    expect(onTerminal).toHaveBeenCalledExactlyOnceWith({
      carrierCallId: `CA-${jobId}`,
      status: 'completed',
    });
    expect(await reconcileTerminalRoute({ jobId, store, control }, { onTerminal })).toBe(
      'already_terminal',
    );
    expect(control.reconcile).toHaveBeenCalledTimes(1);
  });
});
