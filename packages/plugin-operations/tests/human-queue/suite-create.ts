import { describe, expect, it } from 'vitest';
import {
  useHarness,
  ticketKit,
  ORG,
  T0,
  context,
  externalDefinition,
  ticketFor,
  type HqHarness,
} from './harness.ts';

export function describeCreate(make: () => Promise<HqHarness>) {
  const h = useHarness(make);
  const { tickets, queueOf, operator, open, accept, get, states } = ticketKit(h);

  describe('create', () => {
    it('opens a waiting ticket at version 1 with its context and queue', async () => {
      const queue = await queueOf();
      const created = await open(queue, { priority: 3, callbackUntil: '2026-10-16T09:00:00.000Z' });
      expect(created).toMatchObject({
        status: 'waiting',
        version: 1,
        priority: 3,
        kind: 'managed',
        mode: 'OPEN_PICKUP',
        queueId: queue.id,
        queueKey: 'floor',
        language: 'en',
        workspaceId: ORG,
        routerAgentId: 'front-desk',
        callbackUntil: '2026-10-16T09:00:00.000Z',
        createdAt: T0.toISOString(),
        expiresAt: new Date(T0.getTime() + 180_000).toISOString(),
      });
      expect(created.assignedOperatorId).toBeUndefined();
      expect(created.duplicate).toBeUndefined();
      expect(await get(created.id)).toEqual(created);
      expect(await tickets().get('00000000-0000-4000-8000-000000000000')).toBeUndefined();
      expect(await states(created.id)).toEqual(['waiting']);
    });

    it('is idempotent by key: the same ticket comes back marked duplicate', async () => {
      const queue = await queueOf();
      const input = ticketFor(queue);
      const first = await tickets().create(input);
      const again = await tickets().create({ ...input, priority: 9 });
      if (first === 'queue_full' || again === 'queue_full') throw new Error('unexpected');
      expect(again).toMatchObject({ id: first.id, priority: 0, duplicate: true });
      expect(await states(first.id)).toEqual(['waiting']);
      await tickets().release({
        workspaceId: ORG,
        ticketId: first.id,
        expectedVersion: 1,
        reason: 'completed',
        idempotencyKey: 'r',
        code: 'completed',
        by: 'worker',
      });
      // Even an ended ticket answers its key: a retry never opens a second one.
      expect(await tickets().create(input)).toMatchObject({ id: first.id, duplicate: true });
    });

    it('refuses a ticket when the queue holds its maximum waiting', async () => {
      const queue = await queueOf({ limits: { maxWaiting: 2 } });
      await open(queue);
      await open(queue);
      expect(await tickets().create(ticketFor(queue))).toBe('queue_full');
      const other = await queueOf({ limits: { maxWaiting: 1 } });
      expect(await tickets().create(ticketFor(other))).toMatchObject({ status: 'waiting' });
    });

    it('frees a place when a waiting ticket ends', async () => {
      const queue = await queueOf({ limits: { maxWaiting: 1 } });
      const first = await open(queue);
      expect(await tickets().create(ticketFor(queue))).toBe('queue_full');
      await tickets().release({
        workspaceId: ORG,
        ticketId: first.id,
        expectedVersion: 1,
        reason: 'call_ended',
        idempotencyKey: 'r',
        code: 'call_ended',
        by: 'worker',
      });
      expect(await tickets().create(ticketFor(queue))).toMatchObject({ status: 'waiting' });
    });

    it('keeps one active ticket per call: the earlier one is released queue_changed', async () => {
      const queue = await queueOf();
      const other = await queueOf();
      const first = await open(queue, { callId: 'call-x', idempotencyKey: 'hq:org:call-x:1' });
      const second = await open(other, { callId: 'call-x', idempotencyKey: 'hq:org:call-x:2' });
      expect(second.id).not.toBe(first.id);
      expect(await get(first.id)).toMatchObject({
        status: 'released',
        releaseCode: 'queue_changed',
        version: 2,
      });
      expect(await get(second.id)).toMatchObject({ status: 'waiting' });
      const third = await open(queue, { callId: 'call-x', idempotencyKey: 'hq:org:call-x:3' });
      expect(await get(second.id)).toMatchObject({
        status: 'released',
        releaseCode: 'queue_changed',
      });
      expect(third.status).toBe('waiting');
    });

    it('rejects a context that does not match the schema', async () => {
      const queue = await queueOf();
      await expect(
        tickets().create(ticketFor(queue, { context: { ...context(), brief: 'x'.repeat(401) } })),
      ).rejects.toThrow();
    });

    it('opens an external ticket too, which no operator ever sees', async () => {
      const queue = await h.service.queues.create(externalDefinition());
      const created = await open(queue);
      expect(created).toMatchObject({ kind: 'external', status: 'waiting' });
      await operator('asha');
      expect(await tickets().listForOperator('asha', 'queue')).toEqual([]);
    });
  });

  describe('operator views', () => {
    it('shows OPEN_PICKUP tickets in service order, caller masked', async () => {
      const queue = await queueOf({ teamIds: ['support'] });
      await operator('asha', { teamIds: ['support'] });
      const low = await open(queue);
      h.clock.advance(1_000);
      const older = await open(queue, { priority: 5 });
      h.clock.advance(1_000);
      const newer = await open(queue, { priority: 5 });
      h.clock.advance(500);
      const list = await tickets().listForOperator('asha', 'queue');
      expect(list.map((t) => t.id)).toEqual([older.id, newer.id, low.id]);
      expect(list[0]).toMatchObject({
        status: 'waiting',
        offeredToMe: false,
        callerMasked: '+91••••00',
        waitMs: 1_500,
        priority: 5,
        queueKey: 'floor',
      });
      expect(list[0]).not.toHaveProperty('caller');
    });

    it('hides tickets of other teams, languages the queue requires, declined ones and disabled operators', async () => {
      const support = await queueOf({ teamIds: ['support'] });
      const hindi = await queueOf({ language: 'require' });
      await operator('asha', { teamIds: ['support'] });
      await operator('ben', { teamIds: ['sales'], languages: ['hi'] });
      await operator('off', { enabled: false });
      const a = await open(support);
      const b = await open(hindi, { language: 'hi' });
      expect((await tickets().listForOperator('asha', 'queue')).map((t) => t.id)).toEqual([a.id]);
      expect((await tickets().listForOperator('ben', 'queue')).map((t) => t.id)).toEqual([b.id]);
      expect(await tickets().listForOperator('off', 'queue')).toEqual([]);
      expect(await tickets().listForOperator('ghost', 'queue')).toEqual([]);
      expect(
        await tickets().decline({ ticketId: a.id, operatorId: 'asha', expectedVersion: 1 }),
      ).toMatchObject({ status: 'waiting', version: 2 });
      expect(await tickets().listForOperator('asha', 'queue')).toEqual([]);
    });

    it('shows an AUTO_ASSIGN ticket only to the operator it is offered to', async () => {
      const queue = await queueOf({ assignment: 'AUTO_ASSIGN' });
      await operator('asha');
      await operator('ben', {}, 'OFFLINE');
      const ticket = await open(queue);
      expect(ticket).toMatchObject({ status: 'offered', assignedOperatorId: 'asha' });
      const mine = await tickets().listForOperator('asha', 'queue');
      expect(mine).toEqual([
        expect.objectContaining({
          id: ticket.id,
          offeredToMe: true,
          status: 'offered',
          offerExpiresAt: new Date(T0.getTime() + 20_000).toISOString(),
        }),
      ]);
      expect(await tickets().listForOperator('ben', 'queue')).toEqual([]);
    });

    it("lists the operator's own accepted tickets as mine", async () => {
      const queue = await queueOf();
      await operator('asha', { capacity: 2 });
      const a = await open(queue);
      await open(queue);
      await accept(a, 'asha');
      const mine = await tickets().listForOperator('asha', 'mine');
      expect(mine).toEqual([expect.objectContaining({ id: a.id, status: 'accepted', version: 2 })]);
      expect((await tickets().listForOperator('asha', 'queue')).length).toBe(1);
    });
  });
}
