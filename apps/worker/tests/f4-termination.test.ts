import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgresOrchestrationStore } from '@winsendotai/ovo-plugin-orchestration';
import { terminateOwnedJob, terminateOwnedJobAndFinalize } from '../src/worker-termination.ts';

describe('owned carrier termination', () => {
  it.each(['job-lease-lost', 'worker-shutdown'])(
    'finalizes cost after a forced %s carrier exit even when media close throws',
    async (reason) => {
      const events: string[] = [];
      const finalizeCost = vi.fn(async () => {
        events.push('finalize');
      });
      await expect(
        terminateOwnedJobAndFinalize({
          jobId: 'job-forced',
          workerId: 'worker-1',
          ownerEpoch: 7,
          reason,
          store: {
            get: async () => ({ id: 'job-forced', payload: {} }),
            getSessionRoute: async () => ({
              sessionId: 'session-forced',
              jobId: 'job-forced',
              workerId: 'worker-1',
              ownerEpoch: 7,
              carrierCallId: 'CA-forced',
            }),
            requestSessionTermination: async () => {
              events.push('fence');
              return { carrierCallId: 'CA-forced' };
            },
          } as never,
          carriers: {
            forJob: async () => ({
              control: {
                hangup: async () => {
                  events.push('hangup');
                  return 'ended';
                },
              },
              carrier: { capabilities: { control: { hangup: 'close-stream' } } },
            }),
          } as never,
          media: {
            terminate: async () => {
              events.push('media');
            },
            closeSession: async () => {
              events.push('close');
              throw new Error('close failed');
            },
          } as never,
          finalizeCost,
        }),
      ).rejects.toThrow('close failed');
      expect(events).toEqual(['fence', 'hangup', 'media', 'close', 'finalize']);
      expect(finalizeCost).toHaveBeenCalledExactlyOnceWith('job-forced');
    },
  );
  it.each([
    ['job-lease-lost', 'ownership_lost'],
    ['cost-max-duration', 'max_duration'],
  ] as const)('passes %s through close-stream termination as %s', async (raw, expected) => {
    const terminate = vi.fn(async () => undefined);
    const closeSession = vi.fn(async () => undefined);
    await terminateOwnedJob({
      jobId: 'job-reason',
      workerId: 'worker-1',
      ownerEpoch: 3,
      reason: raw,
      store: {
        get: async () => ({ id: 'job-reason', payload: {} }),
        getSessionRoute: async () => ({
          sessionId: 'session-reason',
          jobId: 'job-reason',
          workerId: 'worker-1',
          ownerEpoch: 3,
          carrierCallId: 'CA-reason',
        }),
        requestSessionTermination: async () => ({ carrierCallId: 'CA-reason' }),
      } as never,
      carriers: {
        forJob: async () => ({
          control: { hangup: async () => 'ended' },
          carrier: { capabilities: { control: { hangup: 'close-stream' } } },
        }),
      } as never,
      media: { terminate, closeSession } as never,
    });
    expect(terminate).toHaveBeenCalledWith('session-reason', expected);
    expect(closeSession).toHaveBeenCalledWith('session-reason', expected);
  });
  it('does not select a carrier or close media when the host route fence fails', async () => {
    const order: string[] = [];
    const route = {
      sessionId: 'session-lost',
      jobId: 'job-lost',
      workerId: 'worker-1',
      ownerEpoch: 4,
      carrierCallId: 'CA-lost',
    };
    await expect(
      terminateOwnedJob({
        jobId: route.jobId,
        workerId: route.workerId,
        ownerEpoch: route.ownerEpoch,
        reason: 'ownership_lost',
        store: {
          get: async () => ({ id: route.jobId, payload: { releaseId: 'release-1' } }),
          getSessionRoute: async () => route,
          requestSessionTermination: async () => {
            order.push('fence-failed');
            return undefined;
          },
        } as never,
        carriers: {
          forJob: async () => ({
            control: {
              hangup: async () => {
                order.push('hangup');
                return 'ok';
              },
            },
            carrier: { capabilities: { control: { hangup: 'rest' } } },
          }),
        } as never,
        media: {
          terminate: async () => {
            order.push('media');
          },
          closeSession: async () => {
            order.push('local-close');
          },
        } as never,
      }),
    ).rejects.toThrow('termination fence failed');
    expect(order).toEqual(['fence-failed']);
  });

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
      terminate: async (_sessionId: string, reason: string) => {
        expect(reason).toBe('caller_hangup');
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

describe.skipIf(!process.env.OVO_TEST_POSTGRES_URL)(
  'owned termination with a durable route',
  () => {
    const schema = `o1_termination_${randomUUID().replaceAll('-', '')}`;
    let admin: PostgresOrchestrationStore;
    let store: PostgresOrchestrationStore;

    beforeAll(async () => {
      admin = new PostgresOrchestrationStore({
        connectionString: process.env.OVO_TEST_POSTGRES_URL,
      });
      await admin.pool.query(`CREATE SCHEMA ${schema}`);
      store = new PostgresOrchestrationStore({
        connectionString: process.env.OVO_TEST_POSTGRES_URL,
        options: `-c search_path=${schema}`,
      });
      await store.migrate();
      // Removed when the separately reviewed hint migration joins this branch.
      await store.pool.query('ALTER TABLE ovo_jobs ADD COLUMN IF NOT EXISTS hinted_at timestamptz');
      await store.pool.query(
        'ALTER TABLE ovo_jobs ADD COLUMN IF NOT EXISTS hint_count int NOT NULL DEFAULT 0',
      );
    });

    afterAll(async () => {
      await store?.close();
      if (admin) {
        await admin.pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await admin.close();
      }
    });

    async function route() {
      const jobId = randomUUID();
      const sessionId = randomUUID();
      await store.enqueue({ id: jobId, workspaceId: schema, idempotencyKey: jobId, payload: {} });
      const claimed = await store.claim(jobId, 'worker-1', 60_000);
      if (claimed.kind !== 'execute') throw new Error('expected claim');
      const inserted = await store.beginDialSession({
        sessionId,
        jobId,
        organizationId: schema,
        workerId: 'worker-1',
        workerEndpoint: 'ws://worker.test:4100/internal/media',
        ownerEpoch: claimed.job.ownerEpoch,
        generation: 1,
        dialRequestId: `${jobId}:1`,
        handshakeTokenHash: 'test-hash',
        handshakeExpiresAt: new Date(Date.now() + 60_000),
      });
      expect(inserted).toBeDefined();
      return { jobId, sessionId, epoch: claimed.job.ownerEpoch };
    }

    it('fences the real route before local media closes when binding resolution fails', async () => {
      const { jobId, sessionId, epoch } = await route();
      const events: string[] = [];
      await expect(
        terminateOwnedJob({
          jobId,
          workerId: 'worker-1',
          ownerEpoch: epoch,
          reason: 'job-lease-lost',
          store,
          carriers: {
            forJob: async () => {
              events.push('select');
              throw new Error('binding gone');
            },
          } as never,
          media: {
            terminate: async () => {
              events.push('media');
              expect((await store.getSessionRoute(jobId))?.status).toBe('terminating');
            },
            closeSession: async () => {
              events.push('close');
            },
          } as never,
        }),
      ).rejects.toThrow('binding gone');
      expect(events).toEqual(['select', 'media', 'close']);
      expect((await store.getSessionRoute(jobId))?.status).toBe('terminating');
      expect(
        (
          await store.pool.query(
            'SELECT terminal_reason FROM ovo_session_routes WHERE session_id = $1',
            [sessionId],
          )
        ).rows[0]?.terminal_reason,
      ).toBe('ownership_lost');
    });

    it('never closes media when the owner epoch cannot fence the durable route', async () => {
      const { jobId, epoch } = await route();
      const select = vi.fn();
      const terminate = vi.fn();
      await expect(
        terminateOwnedJob({
          jobId,
          workerId: 'worker-1',
          ownerEpoch: epoch - 1,
          reason: 'job-lease-lost',
          store,
          carriers: { forJob: select } as never,
          media: { terminate, closeSession: terminate } as never,
        }),
      ).rejects.toThrow('termination fence failed');
      expect(select).not.toHaveBeenCalled();
      expect(terminate).not.toHaveBeenCalled();
      expect((await store.getSessionRoute(jobId))?.status).toBe('dialing');
    });
  },
);
