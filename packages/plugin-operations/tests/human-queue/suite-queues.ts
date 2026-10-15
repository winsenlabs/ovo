import { describe, expect, it } from 'vitest';
import {
  useHarness,
  profile,
  externalDefinition,
  managedDefinition,
  ticketFor,
  type HqHarness,
  T0,
} from './harness.ts';
import { HumanQueueNameTakenError } from '../../src/human-queue/service.ts';

export function describeQueues(make: () => Promise<HqHarness>) {
  const h = useHarness(make);

  describe('queues', () => {
    it('creates, reads, lists and updates a queue with a version', async () => {
      const queue = await h.service.queues.create(managedDefinition({ name: 'Support' }));
      expect(queue).toMatchObject({ version: 1, definition: { kind: 'managed', name: 'Support' } });
      expect(queue.createdAt).toBe(T0.toISOString());
      expect(await h.service.queues.get(queue.id)).toEqual(queue);
      expect(await h.service.queues.get('00000000-0000-4000-8000-000000000000')).toBeUndefined();
      const external = await h.service.queues.create(externalDefinition());
      const listed = await h.service.queues.list(10);
      expect(listed.map((q) => q.id)).toEqual([queue.id, external.id].sort());
      expect((await h.service.queues.list(1)).length).toBe(1);
      h.clock.advance(5_000);
      const updated = await h.service.queues.update(
        queue.id,
        managedDefinition({ name: 'Support desk', teamIds: ['support'] }),
        1,
      );
      expect(updated).toMatchObject({ version: 2, definition: { name: 'Support desk' } });
      expect(updated!.updatedAt).toBe(new Date(T0.getTime() + 5_000).toISOString());
      expect(updated!.createdAt).toBe(queue.createdAt);
    });

    it('refuses a stale version and an unknown queue on update', async () => {
      const queue = await h.service.queues.create(managedDefinition());
      expect(await h.service.queues.update(queue.id, managedDefinition(), 2)).toBeUndefined();
      expect(
        await h.service.queues.update(
          '00000000-0000-4000-8000-000000000000',
          managedDefinition(),
          1,
        ),
      ).toBeUndefined();
    });

    it('keeps names unique among live queues, case-insensitively', async () => {
      const first = await h.service.queues.create(managedDefinition({ name: 'Billing' }));
      await expect(
        h.service.queues.create(externalDefinition({ name: 'BILLING' })),
      ).rejects.toThrow(HumanQueueNameTakenError);
      const other = await h.service.queues.create(managedDefinition({ name: 'Other' }));
      await expect(
        h.service.queues.update(other.id, managedDefinition({ name: 'billing' }), 1),
      ).rejects.toThrow(HumanQueueNameTakenError);
      // Renaming a queue to its own name in another case is fine; a deleted queue frees its name.
      expect(
        await h.service.queues.update(first.id, managedDefinition({ name: 'BILLING' }), 1),
      ).toMatchObject({ version: 2 });
      expect(await h.service.queues.remove(other.id, 1)).toBe('removed');
      expect(await h.service.queues.create(managedDefinition({ name: 'OTHER' }))).toBeTruthy();
    });

    it('soft-deletes a queue: hidden, but readable for a pinned release', async () => {
      const queue = await h.service.queues.create(managedDefinition());
      expect(await h.service.queues.remove(queue.id, 5)).toBe('conflict');
      expect(await h.service.queues.remove('00000000-0000-4000-8000-000000000000', 1)).toBe(
        'conflict',
      );
      expect(await h.service.queues.remove(queue.id, 1)).toBe('removed');
      expect(await h.service.queues.get(queue.id)).toBeUndefined();
      expect(await h.service.queues.get(queue.id, { includeDeleted: true })).toMatchObject({
        id: queue.id,
        deletedAt: T0.toISOString(),
      });
      expect((await h.service.queues.list(10)).map((q) => q.id)).not.toContain(queue.id);
      expect(await h.service.queues.update(queue.id, managedDefinition(), 1)).toBeUndefined();
      expect(await h.service.queues.remove(queue.id, 1)).toBe('conflict');
    });

    it('refuses to delete a queue a live point binds, and says which', async () => {
      const queue = await h.service.queues.create(managedDefinition());
      const p1 = '11111111-1111-4111-8111-111111111111';
      const p2 = '22222222-2222-4222-8222-222222222222';
      await h.bindPoint(p2, [queue.id]);
      await h.bindPoint(p1, [queue.id]);
      expect(await h.service.queues.usedBy(queue.id)).toEqual([p1, p2]);
      expect(await h.service.queues.remove(queue.id, 1)).toEqual({ inUseBy: [p1, p2] });
      await h.bindPoint(p1, undefined);
      await h.bindPoint(p2, []);
      expect(await h.service.queues.usedBy(queue.id)).toEqual([]);
      expect(await h.service.queues.remove(queue.id, 1)).toBe('removed');
    });

    it('reports queue stats: waiting, offered, oldest wait, online operators and handled in 24 h', async () => {
      const queue = await h.service.queues.create(
        managedDefinition({ assignment: 'AUTO_ASSIGN', teamIds: ['support'] }),
      );
      await h.service.operators.upsert(profile('asha', { teamIds: ['support'] }));
      await h.service.operators.upsert(profile('ben', { teamIds: ['sales'] }));
      await h.service.operators.heartbeat('asha', 'AVAILABLE');
      await h.service.operators.heartbeat('ben', 'AVAILABLE');
      expect(await h.service.queues.stats(queue.id)).toEqual({
        waiting: 0,
        offered: 0,
        oldestWaitMs: 0,
        online: 1,
        handled24h: 0,
      });
      const a = await h.service.tickets.create(ticketFor(queue));
      h.clock.advance(4_000);
      await h.service.tickets.create(ticketFor(queue));
      h.clock.advance(1_000);
      if (a === 'queue_full') throw new Error('unexpected');
      expect(await h.service.queues.stats(queue.id)).toMatchObject({
        waiting: 1,
        offered: 1,
        oldestWaitMs: 5_000,
        online: 1,
      });
      const accepted = await h.service.tickets.accept({
        workspaceId: 'org',
        ticketId: a.id,
        operatorId: 'asha',
        expectedVersion: a.version,
        idempotencyKey: 'k',
      });
      expect(accepted).toMatchObject({ status: 'accepted' });
      await h.service.tickets.markHandedOff(a.id);
      expect(await h.service.queues.stats(queue.id)).toMatchObject({ handled24h: 1 });
      h.clock.advance(25 * 3_600_000);
      expect((await h.service.queues.stats(queue.id)).handled24h).toBe(0);
      const external = await h.service.queues.create(externalDefinition());
      expect(await h.service.queues.stats(external.id)).toMatchObject({ online: 0 });
    });
  });
}
