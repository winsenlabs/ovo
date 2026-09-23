import { describe, expect, it, vi } from 'vitest';
import { terminateCarrierLeg } from '../src/terminate.ts';

describe('carrier leg termination', () => {
  const route = {
    sessionId: 'session',
    jobId: 'job',
    workerId: 'old-owner',
    ownerEpoch: 3,
    carrierCallId: 'call',
  };
  it.each(['ended', 'unsupported'] as const)(
    'closes a close-stream carrier even when hangup returns %s',
    async (outcome) => {
      const order: string[] = [];
      await terminateCarrierLeg({
        route,
        store: { requestSessionTermination: async () => ({ carrierCallId: 'call' }) },
        control: {
          hangup: async () => {
            order.push('hangup');
            return outcome;
          },
        },
        media: {
          terminate: async () => {
            order.push('media');
          },
        },
        engine: {
          dispose: async () => {
            order.push('dispose');
            return { reason: 'completed', outcome: 'completed' };
          },
        },
        capabilities: { control: { hangup: 'close-stream' } },
        reason: 'completed',
      } as never);
      expect(order).toEqual(['hangup', 'media', 'dispose']);
    },
  );
  it('closes a close-stream carrier and disposes after hangup rejects', async () => {
    const order: string[] = [];
    await expect(
      terminateCarrierLeg({
        route,
        store: { requestSessionTermination: async () => ({ carrierCallId: 'call' }) },
        control: {
          hangup: async () => {
            order.push('hangup');
            throw new Error('carrier 500');
          },
        },
        media: {
          terminate: async () => {
            order.push('media');
          },
        },
        engine: {
          dispose: async () => {
            order.push('dispose');
            return { reason: 'completed', outcome: 'completed' };
          },
        },
        capabilities: { control: { hangup: 'close-stream' } },
        reason: 'completed',
      } as never),
    ).resolves.toBeUndefined();
    expect(order).toEqual(['hangup', 'media', 'dispose']);
  });
  it('fails closed when the termination fence rejects the route', async () => {
    const hangup = vi.fn(async () => 'ended');
    const dispose = vi.fn(async () => ({ reason: 'completed', outcome: 'completed' }));
    await expect(
      terminateCarrierLeg({
        route,
        store: { requestSessionTermination: async () => undefined },
        control: { hangup },
        media: { terminate: vi.fn() },
        engine: { dispose },
        capabilities: { control: { hangup: 'rest' } },
        reason: 'completed',
      } as never),
    ).rejects.toThrow('termination fence');
    expect(hangup).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });
  it('fences, hangs up, then disposes in documented order', async () => {
    const order: string[] = [];
    const base = {
      route,
      store: {
        requestSessionTermination: async () => {
          order.push('fence');
          return { carrierCallId: 'call' };
        },
      },
      control: {
        hangup: async () => {
          order.push('hangup');
          return 'ended';
        },
      },
      media: {
        terminate: async () => {
          order.push('media');
        },
      },
      engine: {
        dispose: async () => {
          order.push('dispose');
          return { reason: 'completed', outcome: 'completed' };
        },
      },
      capabilities: { control: { hangup: 'rest' } },
      reason: 'completed',
    };
    await terminateCarrierLeg(base as never);
    expect(order).toEqual(['fence', 'hangup', 'dispose']);
    order.length = 0;
    await terminateCarrierLeg({
      ...base,
      control: {
        hangup: async () => {
          order.push('hangup');
          return 'unsupported';
        },
      },
      capabilities: { control: { hangup: 'close-stream' } },
    } as never);
    expect(order).toEqual(['fence', 'hangup', 'media', 'dispose']);
  });
});
