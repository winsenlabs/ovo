import { describe, expect, it, vi } from 'vitest';
import { terminateCarrierLeg } from '../src/terminate.ts';

function leg(
  transfer: Parameters<typeof terminateCarrierLeg>[0]['transfer'],
  reason = 'transferred',
) {
  const order: string[] = [];
  const handoff = vi.fn(async () => {
    order.push('handoff');
    return { kind: 'confirmed' as const, receiptId: 'r' };
  });
  const run = terminateCarrierLeg({
    route: { sessionId: 's-1', jobId: 'j-1', workerId: 'w', ownerEpoch: 1, carrierCallId: 'CA1' },
    store: {
      requestSessionTermination: async () => {
        order.push('fence');
        return { carrierCallId: 'CA1' };
      },
    },
    control: {
      hangup: vi.fn(async () => {
        order.push('hangup');
        return 'ended' as const;
      }),
      handoff,
    } as never,
    capabilities: {
      carrierId: 'twilio',
      control: { hangup: 'rest', handoff: ['phone', 'queue'] },
    } as never,
    media: { terminate: async () => void order.push('media') },
    engine: {
      dispose: async () => {
        order.push('dispose');
        return { reason: 'transferred', outcome: 'transferred' };
      },
    },
    reason: reason as never,
    ...(transfer ? { transfer } : {}),
  });
  return { run, order, handoff };
}

describe('a leg the host already handed on (human queue design 7.8)', () => {
  it('is fenced and disposed, never handed on again and never hung up', async () => {
    const { run, order, handoff } = leg({ handedOff: true });
    await run;
    expect(order).toEqual(['fence', 'dispose']);
    expect(handoff).not.toHaveBeenCalled();
  });

  it('only for a transferred ending: any other ending still hangs up', async () => {
    const { run, order } = leg({ handedOff: true }, 'behavior_completed');
    await run;
    expect(order).toEqual(['fence', 'hangup', 'dispose']);
  });

  it('the AGT-15 target form still hands the leg on and skips the hang-up', async () => {
    const { run, order, handoff } = leg({
      target: { kind: 'phone', e164: '+918041234567' },
      workspaceId: 'ws-1',
    });
    await run;
    expect(order).toEqual(['fence', 'handoff', 'dispose']);
    expect(handoff).toHaveBeenCalledOnce();
  });
});
