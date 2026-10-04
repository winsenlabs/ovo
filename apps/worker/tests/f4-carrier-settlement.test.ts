import { describe, expect, it, vi } from 'vitest';
import { settleCarrierDial } from '../src/carrier-dial-settlement.ts';

function fixture(
  reconciled: unknown,
  route: Record<string, unknown> = {},
  correlated: Record<string, unknown> = { carrierCallId: 'CA1' },
) {
  const markFailed = vi.fn(async () => true);
  const markDialAccepted = vi.fn(async () => ({ sessionId: 'session-1' }));
  const deferReconciliation = vi.fn(async () => true);
  const store = {
    markDialUnknown: async () => true,
    get: async () => correlated,
    getSessionRoute: async () => ({
      sessionId: 'session-1',
      carrierRequestId: 'CR1',
      status: 'completed',
      terminalAt: new Date(),
      handshakeClaimedAt: undefined,
      ...route,
    }),
    markDialAccepted,
    markFailed,
    releaseTerminalSession: async () => true,
    deferReconciliation,
  };
  const hangup = vi.fn(async () => 'ok');
  const input = {
    job: { id: 'job-1', ownerEpoch: 9 },
    workerId: 'worker-1',
    delivery: { id: 'delivery-1' },
    payload: {},
    route: { sessionId: 'session-1' },
    queue: { delete: async () => undefined, changeVisibility: async () => undefined },
    lease: { stop: vi.fn() },
    visibility: { stop: vi.fn() },
    protection: { release: async () => undefined },
    deferSeconds: 5,
    recordAttempt: async () => undefined,
    request: { requestId: 'request-1' },
    dial: { kind: 'unknown', reason: 'timed out' } as Record<string, unknown>,
    store,
    selected: { control: { reconcile: vi.fn(async () => reconciled), hangup } },
    onCarrierAccepted: vi.fn(),
  };
  return { input, markFailed, markDialAccepted, deferReconciliation, hangup };
}

describe('carrier dial settlement', () => {
  it('fails completed without a claimed session even when a terminal callback set terminalAt', async () => {
    const { input, markFailed, deferReconciliation } = fixture({
      kind: 'ended',
      state: 'completed',
    });
    await expect(settleCarrierDial(input as never)).resolves.toEqual({
      kind: 'failed',
      reason: 'completed_without_session',
    });
    expect(markFailed).toHaveBeenCalledWith('job-1', 'worker-1', 9, 'completed_without_session');
    expect(deferReconciliation).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: 'ended', state: 'busy' }, 'busy'],
    [{ kind: 'ended', state: 'no_answer' }, 'no_answer'],
    [{ kind: 'ended', state: 'completed', answeredBy: 'machine' }, 'voicemail'],
  ])('maps a terminal carrier result to failed %s', async (reconciled, reason) => {
    const { input, markDialAccepted } = fixture(reconciled);
    await expect(settleCarrierDial(input as never)).resolves.toEqual({ kind: 'failed', reason });
    expect(markDialAccepted).not.toHaveBeenCalled();
  });

  it('persists request-only acceptance without inventing a carrier call ID', async () => {
    const { input, markDialAccepted } = fixture({ kind: 'pending' });
    input.dial = { kind: 'accepted', carrierRequestId: 'CR-only' };
    await expect(settleCarrierDial(input as never)).resolves.toMatchObject({
      kind: 'accepted',
      carrierRequestId: 'CR-only',
    });
    expect(markDialAccepted).toHaveBeenCalledWith(
      expect.objectContaining({
        carrierCallId: undefined,
        carrierRequestId: 'CR-only',
      }),
    );
  });

  it('defers a live carrier outcome with no correlation IDs without accepting it', async () => {
    const { input, markDialAccepted, deferReconciliation } = fixture(
      { kind: 'live', state: 'ringing' },
      { carrierRequestId: undefined },
      {},
    );
    await expect(settleCarrierDial(input as never)).resolves.toEqual({
      kind: 'reconcile_required',
      jobId: 'job-1',
      requestId: 'request-1',
    });
    expect(input.selected.control.reconcile).toHaveBeenCalledWith({
      requestId: 'request-1',
      carrierCallId: undefined,
      carrierRequestId: undefined,
    });
    expect(markDialAccepted).not.toHaveBeenCalled();
    expect(deferReconciliation).toHaveBeenCalledOnce();
  });
});
