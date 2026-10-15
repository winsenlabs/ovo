import { describe, expect, it } from 'vitest';
import {
  useHarness,
  ticketKit,
  context,
  externalDefinition,
  next,
  type HqHarness,
} from './harness.ts';
import type { Ticket } from '../../src/human-queue/service.ts';

export function describeRelease(make: () => Promise<HqHarness>) {
  const h = useHarness(make);
  const { tickets, queueOf, operator, open, accept, get, states } = ticketKit(h);

  describe('release and re-offer', () => {
    const release = (
      ticket: Pick<Ticket, 'id' | 'version'>,
      code: Parameters<HqHarness['service']['tickets']['release']>[0]['code'] = 'completed',
      by: 'worker' | 'operator' | 'sweeper' | 'admin' | 'callback' = 'worker',
      outcome?: 'ended',
    ) =>
      tickets().release({
        workspaceId: h.org,
        ticketId: ticket.id,
        expectedVersion: ticket.version,
        reason: 'completed',
        idempotencyKey: `r-${next()}`,
        code,
        by,
        ...(outcome ? { outcome } : {}),
      });

    it('ends an active ticket with a code, a time and an outcome', async () => {
      const queue = await queueOf();
      await operator('asha');
      const ticket = await open(queue);
      const accepted = (await accept(ticket, 'asha')) as Ticket;
      h.clock.advance(60_000);
      const done = await release(accepted, 'completed', 'worker', 'ended');
      expect(done).toMatchObject({
        status: 'released',
        version: 3,
        releaseCode: 'completed',
        outcome: 'ended',
        releasedAt: h.clock.now().toISOString(),
        assignedOperatorId: 'asha',
      });
      expect(await states(ticket.id)).toEqual(['waiting', 'accepted', 'released']);
      expect((await h.events(ticket.id)).at(-1)!.payload).toMatchObject({
        by: 'worker',
        code: 'completed',
      });
    });

    it('conflicts on a stale version but is idempotent once the ticket has ended', async () => {
      const queue = await queueOf();
      const ticket = await open(queue);
      expect(await release({ id: ticket.id, version: 9 })).toEqual({ kind: 'conflict' });
      expect(await release({ id: '00000000-0000-4000-8000-000000000000', version: 1 })).toEqual({
        kind: 'conflict',
      });
      const done = await release(ticket, 'timed_out');
      expect(await release({ id: ticket.id, version: 99 }, 'call_ended')).toEqual(done);
      expect((await get(ticket.id)).releaseCode).toBe('timed_out');
      expect(
        (await h.events(ticket.id)).filter((e) => e.payload.state === 'released'),
      ).toHaveLength(1);
    });

    it('re-offers an accepted ticket whose operator never joined, without the operator', async () => {
      const queue = await queueOf();
      await operator('asha');
      await operator('ben');
      const ticket = await open(queue);
      const accepted = (await accept(ticket, 'asha')) as Ticket;
      expect(await tickets().reoffer(ticket.id, 1, 'operator_no_show')).toEqual({
        kind: 'conflict',
      });
      const waiting = await tickets().reoffer(ticket.id, accepted.version, 'operator_no_show');
      expect(waiting).toMatchObject({ status: 'waiting', version: 3 });
      expect((waiting as Ticket).assignedOperatorId).toBeUndefined();
      expect((waiting as Ticket).roomName).toBeUndefined();
      expect((waiting as Ticket).acceptedAt).toBeUndefined();
      expect(await tickets().listForOperator('asha', 'queue')).toEqual([]);
      expect((await tickets().listForOperator('ben', 'queue')).map((t) => t.id)).toEqual([
        ticket.id,
      ]);
      expect(await accept({ id: ticket.id, version: 3 }, 'ben')).toMatchObject({
        status: 'accepted',
        assignedOperatorId: 'ben',
      });
      expect(
        (await h.events(ticket.id)).find((e) => e.payload.code === 'operator_no_show')!.payload,
      ).toMatchObject({
        operator: 'asha',
      });
    });

    it('offers the next operator at once when an AUTO_ASSIGN ticket is re-offered', async () => {
      const queue = await queueOf({ assignment: 'AUTO_ASSIGN' });
      await operator('asha');
      await operator('ben');
      const ticket = await open(queue);
      const accepted = (await accept(ticket, 'asha')) as Ticket;
      const again = await tickets().reoffer(ticket.id, accepted.version, 'operator_no_show');
      expect(again).toMatchObject({ status: 'offered', assignedOperatorId: 'ben' });
    });

    it('scrubs context at once with zero retention and after the retention otherwise', async () => {
      const queue = await queueOf();
      await operator('asha');
      const keep = await open(queue, { contextRetentionHours: 2 });
      const drop = await open(queue, { contextRetentionHours: 0 });
      const one = (await accept(keep, 'asha')) as Ticket;
      await tickets().release({
        workspaceId: h.org,
        ticketId: one.id,
        expectedVersion: 2,
        reason: 'completed',
        idempotencyKey: 'r1',
        code: 'completed',
        by: 'worker',
      });
      await tickets().release({
        workspaceId: h.org,
        ticketId: drop.id,
        expectedVersion: 1,
        reason: 'completed',
        idempotencyKey: 'r2',
        code: 'completed',
        by: 'worker',
      });
      expect(await tickets().context(keep.id, { operatorId: 'asha' })).toMatchObject({
        callId: expect.any(String),
      });
      expect(await tickets().context(drop.id, { operatorId: 'asha' })).toBe('forbidden');
      h.clock.advance(2 * 3_600_000 - 1_000);
      expect((await h.service.sweep(h.clock.now())).scrubbed).toBe(0);
      expect(await tickets().context(keep.id, { operatorId: 'asha' })).toMatchObject({
        callId: expect.any(String),
      });
      h.clock.advance(1_000);
      expect((await h.service.sweep(h.clock.now())).scrubbed).toBe(1);
      expect(await tickets().context(keep.id, { operatorId: 'asha' })).toBe('expired');
      expect((await h.service.sweep(h.clock.now())).scrubbed).toBe(0);
      expect(await get(keep.id)).toMatchObject({ status: 'released', releaseCode: 'completed' });
    });
  });

  describe('external tickets', () => {
    const external = async () => {
      const queue = await h.service.queues.create(externalDefinition());
      return open(queue, { credentialId: 'acd-hmac' });
    };

    it('takes one destination, from the sync answer or a callback', async () => {
      const ticket = await external();
      expect(
        await tickets().setDestination(ticket.id, 'callback', { e164: '+914012345678' }, 'acd-1'),
      ).toBe(true);
      expect(await get(ticket.id)).toMatchObject({
        destination: { e164: '+914012345678' },
        externalRef: 'acd-1',
        version: 2,
        status: 'waiting',
        credentialId: 'acd-hmac',
      });
      expect(await tickets().setDestination(ticket.id, 'sync', { e164: '+914099999999' })).toBe(
        false,
      );
      expect((await get(ticket.id)).destination).toEqual({ e164: '+914012345678' });
      expect(
        await tickets().setDestination('00000000-0000-4000-8000-000000000000', 'sync', {
          e164: '+914011111111',
        }),
      ).toBe(false);
    });

    it('refuses a destination for a ticket that ended or is not external', async () => {
      const ticket = await external();
      await tickets().markHandedOff(ticket.id);
      expect(await tickets().setDestination(ticket.id, 'callback', { e164: '+914012345678' })).toBe(
        false,
      );
      const managed = await open(await queueOf());
      expect(await tickets().setDestination(managed.id, 'sync', { e164: '+914012345678' })).toBe(
        false,
      );
    });

    it('records the hand-off once: released handed_off, connected, outcome handed_off', async () => {
      const ticket = await external();
      h.clock.advance(7_000);
      await tickets().markHandedOff(ticket.id);
      const done = await get(ticket.id);
      expect(done).toMatchObject({
        status: 'released',
        releaseCode: 'handed_off',
        outcome: 'handed_off',
        connectedAt: h.clock.now().toISOString(),
      });
      h.clock.advance(1_000);
      await tickets().markHandedOff(ticket.id);
      expect(await get(ticket.id)).toEqual(done);
      await tickets().markHandedOff('00000000-0000-4000-8000-000000000000');
    });
  });
}
