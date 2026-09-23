import { describe, expect, it } from 'vitest';
import { terminateOwnedJob } from '../src/worker-termination.ts';

describe('owned carrier termination', () => {
  it('fences the durable route before carrier and media closure, with engine disposal last', async () => {
    const order: string[] = [];
    const route = {
      sessionId: 'session-1',
      jobId: 'job-1',
      workerId: 'worker-1',
      ownerEpoch: 7,
      carrierCallId: 'CA1',
      carrierRequestId: 'CR1',
    };
    const store = {
      get: async () => ({ id: 'job-1', payload: { releaseId: 'release-1' } }),
      getSessionRoute: async () => route,
      requestSessionTermination: async () => {
        order.push('fence');
        return { carrierCallId: 'CA1', carrierRequestId: 'CR1' };
      },
    };
    const carriers = {
      forJob: async () => {
        order.push('select');
        return {
          control: {
            hangup: async () => {
              order.push('hangup');
              return 'ok';
            },
          },
          carrier: { capabilities: { control: { hangup: 'close-stream' } } },
        };
      },
    };
    const media = {
      terminate: async () => {
        order.push('media');
      },
      closeSession: async () => {
        order.push('engine');
      },
    };
    expect(
      await terminateOwnedJob({
        jobId: 'job-1',
        workerId: 'worker-1',
        ownerEpoch: 7,
        reason: 'caller_hangup',
        store: store as never,
        carriers: carriers as never,
        media: media as never,
      }),
    ).toBe(true);
    expect(order).toEqual(['fence', 'select', 'hangup', 'media', 'engine']);
  });

  it('fences and closes local media when carrier binding resolution fails', async () => {
    const order: string[] = [];
    await expect(
      terminateOwnedJob({
        jobId: 'job-2',
        workerId: 'worker-1',
        ownerEpoch: 4,
        reason: 'drain',
        store: {
          get: async () => ({ id: 'job-2', payload: {} }),
          getSessionRoute: async () => ({ sessionId: 'session-2', jobId: 'job-2' }),
          requestSessionTermination: async () => {
            order.push('fence');
            return {};
          },
        } as never,
        carriers: {
          forJob: async () => {
            order.push('select');
            throw new Error('binding gone');
          },
        } as never,
        media: {
          terminate: async () => {
            order.push('media');
          },
          closeSession: async () => {
            order.push('engine');
          },
        } as never,
      }),
    ).rejects.toThrow('binding gone');
    expect(order).toEqual(['fence', 'select', 'media', 'engine']);
  });
});
