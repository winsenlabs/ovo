import type { HandoffBeginResult, MemberClaim } from '@winsendotai/ovo-contracts';
import { describe, expect, it } from 'vitest';
import { transferPolicy } from './transfer-fixtures.ts';
import { ask, OTHER_POOL, port, signal, targets } from './transfer-port-fixture.ts';

describe('the agent transfer port: offers and refusals (transfer design 4.3, 7.2)', () => {
  it('offers the targets granted to this segment, while the call can still transfer', () => {
    expect(port().port.targets()).toEqual([
      {
        key: 'billing',
        description: 'Payments and refunds',
        label: 'our billing team',
        confirm: 'never',
      },
      { key: 'senior', description: 'A senior colleague', confirm: 'ask' },
      { key: 'myself', description: 'Myself', confirm: 'never' },
      { key: 'language', description: 'Another language', confirm: 'never' },
    ]);
    expect(port({ language: 'hi' }).port.targets()[0]!.label).toBe('बिलिंग टीम');
    expect(port({ transfers: 3 }).port.targets()).toEqual([]);
    expect(port({ remainingSeconds: 20 }).port.targets()).toEqual([]);
    expect(port({ segments: 16 }).port.targets()).toEqual([]);
    expect(port({ policy: 'none' }).port.targets()).toEqual([]);
  });

  it("says whether the point's handover takes the transferring agent's summary", () => {
    expect(port().port.summary).toBe(true);
    expect(port({ policy: 'none' }).port.summary).toBe(true);
    const policy = transferPolicy({ targets });
    const without = { ...policy, handover: { ...policy.handover, summary: false } };
    expect(port({ policy: without }).port.summary).toBe(false);
  });

  it.each([
    ['transfer_disabled', { policy: 'none' as const }, 'billing'],
    ['unknown_target', {}, 'nowhere'],
    ['not_granted', {}, 'desk'],
    ['limit_reached', { transfers: 3 }, 'billing'],
    ['segments_exhausted', { segments: 16 }, 'billing'],
    ['time_exhausted', { remainingSeconds: 29 }, 'billing'],
    ['not_confirmed', {}, 'senior'],
    ['same_agent', {}, 'myself'],
    ['pool_full', { claim: { kind: 'full' } as MemberClaim }, 'billing'],
    [
      'release_missing',
      { begin: { ok: false, reason: 'release_not_allowed' } as HandoffBeginResult },
      'language',
    ],
  ])('refuses %s, records it, and begins nothing', async (refusal, options, key) => {
    const h = port(options);
    expect(await h.port.request(ask(key), signal())).toEqual({ ok: false, reason: refusal });
    expect(h.recorded).toEqual([
      [
        'transfer.requested',
        expect.objectContaining({ result: 'refused', refusal, key, fromSegment: 2, source: 'llm' }),
      ],
    ]);
    if (refusal !== 'release_missing') expect(h.begun).toEqual([]);
  });

  it('refuses while a transfer is in flight, and once this segment is no longer attached', async () => {
    const busy = port();
    busy.controller.busy = true;
    expect(await busy.port.request(ask('billing'), signal())).toEqual({
      ok: false,
      reason: 'busy',
    });
    const gone = port();
    gone.controller.attached = { index: 3 };
    expect(await gone.port.request(ask('billing'), signal())).toEqual({
      ok: false,
      reason: 'call_ended',
    });
  });

  it('refuses a pool with no member the call can reach', async () => {
    const policy = transferPolicy({
      targets: [
        {
          key: 'tamil',
          description: 'Tamil speakers',
          destination: { kind: 'pool', poolId: OTHER_POOL, language: 'caller', skills: ['tamil'] },
        },
      ],
    });
    expect(await port({ policy }).port.request(ask('tamil'), signal())).toEqual({
      ok: false,
      reason: 'no_eligible_member',
    });
  });
});
