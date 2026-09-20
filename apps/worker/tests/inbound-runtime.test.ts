import { describe, expect, it, vi } from 'vitest';
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
  const hangup = vi.fn(async () => undefined);
  const costs = { reserve: vi.fn() };
  const runtime = new InboundWorkerRuntime({
    workerId: 'worker-1',
    workerEndpoint: 'worker://worker-1',
    generation: 42,
    protection,
    operations: { inbound: { registerProtectedCapacity, suspendProtectedCapacity } } as never,
    store: { requestSessionTermination } as never,
    telephony: { hangup } as never,
    costs: costs as never,
    onProtectionLost: vi.fn(),
  });
  return {
    runtime,
    protection,
    registerProtectedCapacity,
    suspendProtectedCapacity,
    requestSessionTermination,
    hangup,
    costs,
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
