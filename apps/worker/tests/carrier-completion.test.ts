import { describe, expect, it, vi } from 'vitest';
import { reconcileClaimedCarrierDial } from '../src/reconciliation.ts';

describe('carrier reconciliation completion', () => {
  it('fails a completed carrier call when a terminal callback arrived but no session opened', async () => {
    const markFailed = vi.fn(async () => true);
    const markDialAccepted = vi.fn();
    const deferReconciliation = vi.fn(async () => true);
    const changeVisibility = vi.fn(async () => undefined);
    const result = await reconcileClaimedCarrierDial({
      workerId: 'worker-1',
      job: { id: 'job-1', ownerEpoch: 7, dialRequestId: 'request-1' } as never,
      delivery: { id: 'delivery-1' } as never,
      store: {
        getSessionRoute: async () => ({
          sessionId: 'session-1',
          status: 'completed',
          terminalAt: new Date(),
          handshakeClaimedAt: undefined,
        }),
        markFailed,
        markDialAccepted,
        deferReconciliation,
        releaseTerminalSession: async () => true,
      } as never,
      queue: { delete: async () => undefined, changeVisibility } as never,
      carriers: {
        forJob: async () => ({
          control: { reconcile: async () => ({ kind: 'ended', state: 'completed' }) },
        }),
      } as never,
      deferSeconds: 5,
    });
    expect(result).toEqual({ kind: 'failed', reason: 'completed_without_session' });
    expect(markFailed).toHaveBeenCalledWith('job-1', 'worker-1', 7, 'completed_without_session');
    expect(markDialAccepted).not.toHaveBeenCalled();
    expect(deferReconciliation).not.toHaveBeenCalled();
    expect(changeVisibility).not.toHaveBeenCalled();
  });
});
