import { describe, expect, it, vi } from 'vitest';
import { Cap } from '@winsendotai/ovo-contracts';
import type { Composition } from '@winsendotai/ovo-runtime';
import { recordOptOut } from '../src/opt-out-dnc.ts';

function composition(behavior: unknown): Pick<Composition, 'ctx'> {
  return {
    ctx: { get: (key: string) => (key === Cap.behavior ? behavior : undefined) },
  } as unknown as Pick<Composition, 'ctx'>;
}

describe('opt-out to the do-not-call list', () => {
  it('lists the dialed number of an outbound call with the call id', async () => {
    const add = vi.fn(async () => undefined);
    const audit = vi.fn();
    await recordOptOut({
      composition: composition({ optedOut: true }),
      doNotCall: { add },
      payload: { kind: 'campaign_dial_candidate', to: '+919800000001', from: '+918000000000' },
      callId: 'call-1',
      telemetry: { audit },
    });
    expect(add).toHaveBeenCalledWith('+919800000001', 'Caller asked not to be called again', {
      source: 'opt_out',
      callId: 'call-1',
    });
    expect(audit).toHaveBeenCalledWith('compliance.opt-out.recorded', { callId: 'call-1' });
  });

  it('lists the calling number of an inbound call', async () => {
    const add = vi.fn(async () => undefined);
    await recordOptOut({
      composition: composition({ optedOut: true }),
      doNotCall: { add },
      payload: { kind: 'inbound_call', from: '+919800000002', to: '+918000000000' },
      callId: 'call-2',
      telemetry: { audit: vi.fn() },
    });
    expect(add).toHaveBeenCalledWith('+919800000002', expect.any(String), {
      source: 'opt_out',
      callId: 'call-2',
    });
  });

  it('does nothing unless the caller opted out', async () => {
    const add = vi.fn(async () => undefined);
    for (const behavior of [undefined, {}, { optedOut: false }])
      await recordOptOut({
        composition: composition(behavior),
        doNotCall: { add },
        payload: { to: '+919800000003' },
        callId: 'call-3',
        telemetry: { audit: vi.fn() },
      });
    expect(add).not.toHaveBeenCalled();
  });

  it('audits, never throws, when the list cannot be written', async () => {
    const audit = vi.fn();
    await expect(
      recordOptOut({
        composition: composition({ optedOut: true }),
        doNotCall: { add: vi.fn(async () => Promise.reject(new Error('pool closed'))) },
        payload: { to: '+919800000004' },
        callId: 'call-4',
        telemetry: { audit },
      }),
    ).resolves.toBeUndefined();
    expect(audit).toHaveBeenCalledWith('compliance.opt-out.unrecorded', {
      reason: 'write-failed',
      message: 'pool closed',
    });
    await recordOptOut({
      composition: composition({ optedOut: true }),
      payload: { to: '+919800000004' },
      callId: 'call-4',
      telemetry: { audit },
    });
    expect(audit).toHaveBeenLastCalledWith('compliance.opt-out.unrecorded', {
      reason: 'do-not-call-unavailable',
    });
  });
});
