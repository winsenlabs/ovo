import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DurableJob, SessionRoute } from '@winsendotai/ovo-plugin-orchestration';
import { InboundWorkerRuntime } from '../src/inbound-runtime.ts';

function fixture() {
  const registerProtectedCapacity = vi.fn(async () => true);
  const suspendProtectedCapacity = vi.fn(async () => true);
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
  afterEach(() => vi.useRealTimers());

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
    expect(subject.protection.release).toHaveBeenCalledOnce();
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
    const subject = fixture();
    subject.protection.renew.mockResolvedValue(false);
    subject.costs.reserve.mockResolvedValue({ admitted: true, beginActiveCall: vi.fn() });

    await subject.runtime.start();
    await subject.runtime.admitSession(inboundJob, route);
    await vi.advanceTimersByTimeAsync(45_000);

    expect(subject.heartbeat).not.toHaveBeenCalled();
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
