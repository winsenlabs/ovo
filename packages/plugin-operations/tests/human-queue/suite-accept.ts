import { describe, expect, it } from 'vitest';
import {
  useHarness,
  ticketKit,
  ORG,
  T0,
  externalDefinition,
  next,
  type HqHarness,
} from './harness.ts';
import type { Ticket } from '../../src/human-queue/service.ts';

export function describeAccept(make: () => Promise<HqHarness>) {
  const h = useHarness(make);
  const { tickets, queueOf, operator, open, accept, get, states } = ticketKit(h);

  describe('accept', () => {
    it('moves a waiting ticket to accepted for the operator, with its room', async () => {
      const queue = await queueOf();
      await operator('asha');
      const ticket = await open(queue);
      h.clock.advance(2_000);
      const accepted = await accept(ticket, 'asha');
      expect(accepted).toMatchObject({
        status: 'accepted',
        version: 2,
        assignedOperatorId: 'asha',
        roomName: `ovo-hq-${ticket.id}`,
        acceptedAt: new Date(T0.getTime() + 2_000).toISOString(),
      });
      expect(await states(ticket.id)).toEqual(['waiting', 'accepted']);
    });

    it('is idempotent by key: a replay returns the ticket, another operator conflicts', async () => {
      const queue = await queueOf();
      await operator('asha');
      await operator('ben');
      const ticket = await open(queue);
      const first = await accept(ticket, 'asha', 'same');
      expect(await accept(ticket, 'asha', 'same')).toEqual(first);
      expect(await accept(ticket, 'ben', 'same')).toEqual({ kind: 'conflict' });
      expect(await accept(ticket, 'ben', 'other')).toEqual({ kind: 'conflict' });
      expect((await get(ticket.id)).version).toBe(2);
      expect(await states(ticket.id)).toEqual(['waiting', 'accepted']);
    });

    it('conflicts on a stale version, a missing ticket, another workspace and a taken ticket', async () => {
      const queue = await queueOf();
      await operator('asha');
      const ticket = await open(queue);
      expect(await accept({ id: ticket.id, version: 7 }, 'asha')).toEqual({ kind: 'conflict' });
      expect(
        await accept({ id: '00000000-0000-4000-8000-000000000000', version: 1 }, 'asha'),
      ).toEqual({
        kind: 'conflict',
      });
      expect(
        await tickets().accept({
          workspaceId: 'someone-else',
          ticketId: ticket.id,
          operatorId: 'asha',
          expectedVersion: 1,
          idempotencyKey: 'x',
        }),
      ).toEqual({ kind: 'conflict' });
      await accept(ticket, 'asha');
      expect(await accept(ticket, 'asha')).toEqual({ kind: 'conflict' });
    });

    it('refuses an operator who is not eligible', async () => {
      const queue = await queueOf({ teamIds: ['support'], language: 'require' });
      await operator('asha', { teamIds: ['support'] });
      await operator('team', { teamIds: ['sales'] });
      await operator('lang', { teamIds: ['support'], languages: ['hi'] });
      await operator('away', { teamIds: ['support'] }, 'AWAY');
      await operator('off', { teamIds: ['support'] }, 'OFFLINE');
      await operator('disabled', { teamIds: ['support'], enabled: false });
      const ticket = await open(queue);
      for (const id of ['team', 'lang', 'off', 'disabled', 'ghost'])
        expect(await accept(ticket, id), id).toEqual({ kind: 'not_eligible' });
      expect(await accept(ticket, 'away')).toMatchObject({ status: 'accepted' });
      expect((await get(ticket.id)).version).toBe(2);
    });

    it('refuses an operator whose heartbeat has lapsed', async () => {
      const queue = await queueOf();
      await operator('asha');
      const ticket = await open(queue);
      h.clock.advance(31_000);
      expect(await accept(ticket, 'asha')).toEqual({ kind: 'not_eligible' });
      await h.service.operators.heartbeat('asha');
      expect(await accept({ id: ticket.id, version: 1 }, 'asha')).toMatchObject({
        status: 'accepted',
      });
    });

    it('refuses an operator at capacity until a ticket ends', async () => {
      const queue = await queueOf();
      await operator('asha', { capacity: 2 });
      await operator('zero', { capacity: 0 });
      const [a, b, c] = [await open(queue), await open(queue), await open(queue)] as [
        Ticket,
        Ticket,
        Ticket,
      ];
      expect(await accept(a, 'zero')).toEqual({ kind: 'at_capacity' });
      expect(await accept(a, 'asha')).toMatchObject({ status: 'accepted' });
      expect(await accept(b, 'asha')).toMatchObject({ status: 'accepted' });
      expect(await accept(c, 'asha')).toEqual({ kind: 'at_capacity' });
      await tickets().release({
        workspaceId: ORG,
        ticketId: a.id,
        expectedVersion: 2,
        reason: 'completed',
        idempotencyKey: 'r',
        code: 'completed',
        by: 'operator',
      });
      expect(await accept(c, 'asha')).toMatchObject({ status: 'accepted' });
    });

    it('lets exactly one of several operators win a concurrent accept', async () => {
      const queue = await queueOf();
      const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
      for (const id of ids) await operator(id);
      const ticket = await open(queue);
      const results = await Promise.all(ids.map((id) => accept(ticket, id)));
      const winners = results.filter((r) => 'status' in r && r.status === 'accepted');
      expect(winners).toHaveLength(1);
      expect(results.filter((r) => 'kind' in r && r.kind === 'conflict')).toHaveLength(
        ids.length - 1,
      );
      const final = await get(ticket.id);
      expect(final.version).toBe(2);
      expect(final.assignedOperatorId).toBe((winners[0] as Ticket).assignedOperatorId);
      expect(await states(ticket.id)).toEqual(['waiting', 'accepted']);
    });

    it('holds an operator to capacity when they accept several tickets at once', async () => {
      const queue = await queueOf();
      await operator('asha', { capacity: 2 });
      const batch = await Promise.all(Array.from({ length: 5 }, () => open(queue)));
      const results = await Promise.all(batch.map((t) => accept(t, 'asha')));
      expect(results.filter((r) => 'status' in r)).toHaveLength(2);
      expect(results.filter((r) => 'kind' in r && r.kind === 'at_capacity')).toHaveLength(3);
      expect((await h.service.operators.list())[0]!.active).toBe(2);
    });

    it('refuses to accept an external ticket', async () => {
      const queue = await h.service.queues.create(externalDefinition());
      await operator('asha');
      const ticket = await open(queue);
      expect(await accept(ticket, 'asha')).toEqual({ kind: 'conflict' });
    });
  });

  describe('decline', () => {
    it('hides an OPEN_PICKUP ticket from the decliner only', async () => {
      const queue = await queueOf();
      await operator('asha');
      await operator('ben');
      const ticket = await open(queue);
      expect(
        await tickets().decline({ ticketId: ticket.id, operatorId: 'asha', expectedVersion: 1 }),
      ).toMatchObject({
        status: 'waiting',
        version: 2,
      });
      expect(await tickets().listForOperator('asha', 'queue')).toEqual([]);
      expect((await tickets().listForOperator('ben', 'queue')).map((t) => t.id)).toEqual([
        ticket.id,
      ]);
      expect(await accept({ id: ticket.id, version: 2 }, 'asha')).toEqual({ kind: 'not_eligible' });
      expect(await accept({ id: ticket.id, version: 2 }, 'ben')).toMatchObject({
        status: 'accepted',
      });
    });

    it('rotates an AUTO_ASSIGN offer to the next operator, then leaves it waiting', async () => {
      const queue = await queueOf({ assignment: 'AUTO_ASSIGN' });
      await operator('asha');
      await operator('ben');
      const ticket = await open(queue);
      expect(ticket.assignedOperatorId).toBe('asha');
      const second = await tickets().decline({
        ticketId: ticket.id,
        operatorId: 'asha',
        expectedVersion: 2,
      });
      expect(second).toMatchObject({ status: 'offered', assignedOperatorId: 'ben', version: 4 });
      const third = await tickets().decline({
        ticketId: ticket.id,
        operatorId: 'ben',
        expectedVersion: 4,
      });
      expect(third).toMatchObject({ status: 'waiting', version: 5 });
      expect((third as Ticket).assignedOperatorId).toBeUndefined();
      expect(await states(ticket.id)).toEqual([
        'waiting',
        'offered',
        'waiting',
        'offered',
        'waiting',
      ]);
    });

    it('conflicts on a stale version, on an offer made to someone else, and for a stranger', async () => {
      const queue = await queueOf({ assignment: 'AUTO_ASSIGN', teamIds: ['support'] });
      await operator('asha', { teamIds: ['support'] });
      await operator('ben', { teamIds: ['support'] }, 'OFFLINE');
      await operator('out', { teamIds: ['sales'] });
      const ticket = await open(queue);
      expect(
        await tickets().decline({ ticketId: ticket.id, operatorId: 'asha', expectedVersion: 1 }),
      ).toEqual({
        kind: 'conflict',
      });
      expect(
        await tickets().decline({ ticketId: ticket.id, operatorId: 'ben', expectedVersion: 2 }),
      ).toEqual({
        kind: 'conflict',
      });
      expect(
        await tickets().decline({ ticketId: ticket.id, operatorId: 'out', expectedVersion: 2 }),
      ).toEqual({
        kind: 'conflict',
      });
      expect(
        await tickets().decline({ ticketId: ticket.id, operatorId: 'ghost', expectedVersion: 2 }),
      ).toEqual({
        kind: 'conflict',
      });
    });
  });
}
