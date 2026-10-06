import { describe, expect, it, vi } from 'vitest';
import type { HandoffTarget } from '@winsendotai/ovo-contracts';
import { terminateCarrierLeg } from '../src/terminate.ts';

const target: HandoffTarget = { kind: 'phone', e164: '+918041234567' };

function leg(
  handoff: (...args: unknown[]) => unknown,
  over: { reason?: string; transfer?: boolean; kinds?: string[] } = {},
) {
  const order: string[] = [];
  const hangup = vi.fn(async () => {
    order.push('hangup');
    return 'ended' as const;
  });
  const run = terminateCarrierLeg({
    route: { sessionId: 's-1', jobId: 'j-1', workerId: 'w', ownerEpoch: 1, carrierCallId: 'CA1' },
    store: { requestSessionTermination: async () => ({ carrierCallId: 'CA1' }) },
    control: {
      hangup,
      handoff: vi.fn(async (...args: unknown[]) => {
        order.push('handoff');
        return handoff(...args);
      }),
    } as never,
    capabilities: {
      carrierId: 'twilio',
      control: { hangup: 'rest', handoff: over.kinds ?? ['phone', 'queue'] },
    } as never,
    media: { terminate: async () => void order.push('media') },
    engine: {
      dispose: async () => {
        order.push('dispose');
        return { reason: 'transferred', outcome: 'transferred' };
      },
    },
    reason: (over.reason ?? 'transferred') as never,
    ...(over.transfer === false ? {} : { transfer: { target, workspaceId: 'ws-1' } }),
  });
  return { run, order, hangup };
}

describe('a transferred call is handed on, not hung up (AGT-15)', () => {
  it('hands the leg to the target through the carrier and skips the hang-up', async () => {
    const handoff = vi.fn(async () => ({ kind: 'confirmed', receiptId: 'r' }));
    const { run, order } = leg(handoff);
    await run;
    expect(order).toEqual(['handoff', 'dispose']);
    expect(handoff).toHaveBeenCalledWith('CA1', target, 'transfer:s-1');
  });

  it('hangs up when the carrier refuses the transfer, so the call never stays open', async () => {
    const { run, order } = leg(
      vi.fn(async () => ({ kind: 'rejected', retryable: false, reason: 'x' })),
    );
    await run;
    expect(order).toEqual(['handoff', 'hangup', 'dispose']);
  });

  it('hangs up without asking when the carrier cannot reach the target kind', async () => {
    const handoff = vi.fn();
    const { run, order } = leg(handoff, { kinds: [] });
    await run;
    expect(order).toEqual(['hangup', 'dispose']);
    expect(handoff).not.toHaveBeenCalled();
  });

  it('leaves every other ending, and a transfer with no target, to the hang-up', async () => {
    for (const over of [{ reason: 'behavior_completed' }, { transfer: false }]) {
      const handoff = vi.fn();
      const { run, order } = leg(handoff, over);
      await run;
      expect(order).toEqual(['hangup', 'dispose']);
      expect(handoff).not.toHaveBeenCalled();
    }
  });
});
