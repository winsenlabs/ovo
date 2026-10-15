import { describe, expect, it } from 'vitest';
import {
  useHarness,
  profile,
  managedDefinition,
  ticketFor,
  type HqHarness,
  T0,
} from './harness.ts';

export function describeOperators(make: () => Promise<HqHarness>) {
  const h = useHarness(make);

  describe('operators', () => {
    it('stores a profile and keeps presence out of it', async () => {
      await h.service.operators.upsert(profile('asha', { teamIds: ['support'], capacity: 2 }));
      expect(await h.service.operators.get('asha')).toEqual(
        profile('asha', { teamIds: ['support'], capacity: 2 }),
      );
      expect(await h.service.operators.get('nobody')).toBeUndefined();
      expect(await h.service.operators.list()).toEqual([
        { ...profile('asha', { teamIds: ['support'], capacity: 2 }), status: 'OFFLINE', active: 0 },
      ]);
      await h.service.operators.heartbeat('asha', 'AWAY');
      await h.service.operators.upsert(profile('asha', { displayName: 'Asha K', capacity: 3 }));
      expect(await h.service.operators.list()).toEqual([
        expect.objectContaining({
          displayName: 'Asha K',
          capacity: 3,
          status: 'AWAY',
          lastSeenAt: T0.toISOString(),
        }),
      ]);
    });

    it('lists operators ordered by user id', async () => {
      for (const id of ['cy', 'asha', 'ben']) await h.service.operators.upsert(profile(id));
      expect((await h.service.operators.list()).map((o) => o.userId)).toEqual([
        'asha',
        'ben',
        'cy',
      ]);
    });

    it('sets presence with a heartbeat, and a heartbeat alone refreshes it', async () => {
      await h.service.operators.upsert(profile('asha'));
      expect(await h.service.operators.heartbeat('asha', 'AVAILABLE')).toEqual({
        status: 'AVAILABLE',
      });
      h.clock.advance(20_000);
      expect(await h.service.operators.heartbeat('asha')).toEqual({ status: 'AVAILABLE' });
      h.clock.advance(20_000);
      expect((await h.service.operators.list())[0]!.status).toBe('AVAILABLE');
      expect(await h.service.operators.heartbeat('asha', 'AWAY')).toEqual({ status: 'AWAY' });
      expect(await h.service.operators.heartbeat('asha', 'OFFLINE')).toEqual({ status: 'OFFLINE' });
    });

    it('reads a stale operator as OFFLINE without a write, and a new heartbeat revives them', async () => {
      await h.service.operators.upsert(profile('asha'));
      await h.service.operators.heartbeat('asha', 'AVAILABLE');
      h.clock.advance(30_000);
      expect((await h.service.operators.list())[0]!.status).toBe('AVAILABLE');
      h.clock.advance(1_000);
      expect((await h.service.operators.list())[0]!.status).toBe('OFFLINE');
      expect(await h.service.operators.heartbeat('asha')).toEqual({ status: 'AVAILABLE' });
    });

    it('keeps a disabled or unknown operator OFFLINE', async () => {
      await h.service.operators.upsert(profile('asha', { enabled: false }));
      expect(await h.service.operators.heartbeat('asha', 'AVAILABLE')).toEqual({
        status: 'OFFLINE',
      });
      expect(await h.service.operators.heartbeat('ghost', 'AVAILABLE')).toEqual({
        status: 'OFFLINE',
      });
      expect((await h.service.operators.list())[0]).toMatchObject({ status: 'OFFLINE' });
      expect((await h.service.operators.list()).length).toBe(1);
    });

    it('counts availability by team, language rule and room', async () => {
      await h.service.operators.upsert(
        profile('asha', { teamIds: ['support'], languages: ['en', 'hi'], capacity: 1 }),
      );
      await h.service.operators.upsert(profile('ben', { teamIds: ['sales'], languages: ['en'] }));
      await h.service.operators.upsert(
        profile('cy', { teamIds: ['support'], languages: ['en'], capacity: 0 }),
      );
      await h.service.operators.upsert(
        profile('dee', { teamIds: ['support'], languages: ['hi'], enabled: false }),
      );
      await h.service.operators.upsert(profile('eli', { teamIds: ['support'], languages: ['en'] }));
      for (const id of ['asha', 'ben', 'cy', 'dee'])
        await h.service.operators.heartbeat(id, 'AVAILABLE');
      await h.service.operators.heartbeat('eli', 'AWAY');
      const support = { queueId: 'q', teamIds: ['support'], language: 'ignore' as const };
      expect(await h.service.operators.availability(support)).toEqual({ online: 2, withRoom: 1 });
      expect(await h.service.operators.availability({ ...support, teamIds: [] })).toEqual({
        online: 3,
        withRoom: 2,
      });
      expect(
        await h.service.operators.availability({ ...support, language: 'require' }, 'hi'),
      ).toEqual({
        online: 1,
        withRoom: 1,
      });
      expect(await h.service.operators.availability({ ...support, language: 'require' })).toEqual({
        online: 0,
        withRoom: 0,
      });
      expect(
        await h.service.operators.availability({ ...support, language: 'prefer' }, 'hi'),
      ).toEqual({
        online: 2,
        withRoom: 1,
      });
    });

    it('counts a held ticket against room', async () => {
      const queue = await h.service.queues.create(managedDefinition());
      await h.service.operators.upsert(profile('asha'));
      await h.service.operators.heartbeat('asha', 'AVAILABLE');
      const ref = { queueId: queue.id, teamIds: [], language: 'ignore' as const };
      expect(await h.service.operators.availability(ref)).toEqual({ online: 1, withRoom: 1 });
      const ticket = await h.service.tickets.create(ticketFor(queue));
      if (ticket === 'queue_full') throw new Error('unexpected');
      await h.service.tickets.accept({
        workspaceId: h.org,
        ticketId: ticket.id,
        operatorId: 'asha',
        expectedVersion: 1,
        idempotencyKey: 'k',
      });
      expect(await h.service.operators.availability(ref)).toEqual({ online: 1, withRoom: 0 });
      expect((await h.service.operators.list())[0]!.active).toBe(1);
    });

    it('answers the port presence shape for a queue, capped at capacity', async () => {
      const queue = await h.service.queues.create(managedDefinition({ teamIds: ['support'] }));
      await h.service.operators.upsert(profile('asha', { teamIds: ['support'], capacity: 2 }));
      await h.service.operators.upsert(profile('ben', { teamIds: ['sales'] }));
      await h.service.operators.heartbeat('asha', 'AVAILABLE');
      const presence = await h.service.operators.presence({
        workspaceId: h.org,
        queueId: queue.id,
      });
      expect(presence).toEqual([
        {
          operatorId: 'asha',
          status: 'AVAILABLE',
          capacity: 2,
          activeAssignments: 0,
          teamIds: ['support'],
          updatedAt: T0.toISOString(),
        },
      ]);
    });
  });
}
