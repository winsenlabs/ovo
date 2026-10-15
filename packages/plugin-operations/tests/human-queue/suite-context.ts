import { describe, expect, it } from 'vitest';
import {
  useHarness,
  ticketKit,
  ORG,
  context,
  externalDefinition,
  type HqHarness,
} from './harness.ts';

export function describeContext(make: () => Promise<HqHarness>) {
  const h = useHarness(make);
  const { tickets, queueOf, operator, open, accept } = ticketKit(h);

  describe('events, context and the change feed', () => {
    it('appends events once per source id and refuses oversize payloads', async () => {
      const queue = await queueOf();
      const ticket = await open(queue);
      const event = { kind: 'callback', sourceEventId: 'evt-1', payload: { event: 'accepted' } };
      expect(await tickets().appendEvent(ticket.id, event)).toBe('recorded');
      expect(await tickets().appendEvent(ticket.id, event)).toBe('duplicate');
      expect(await tickets().appendEvent(ticket.id, { ...event, sourceEventId: 'evt-2' })).toBe(
        'recorded',
      );
      expect(await tickets().appendEvent(ticket.id, { kind: 'note', payload: {} })).toBe(
        'recorded',
      );
      expect(await tickets().appendEvent(ticket.id, { kind: 'note', payload: {} })).toBe(
        'recorded',
      );
      await expect(
        tickets().appendEvent(ticket.id, { kind: 'big', payload: { text: 'x'.repeat(4_100) } }),
      ).rejects.toThrow(/bytes/);
      await expect(
        tickets().appendEvent('00000000-0000-4000-8000-000000000000', event),
      ).rejects.toThrow();
      // The same source id on another ticket is a different event.
      const other = await open(queue);
      expect(await tickets().appendEvent(other.id, event)).toBe('recorded');
    });

    it('gives the context to the assigned operator only', async () => {
      const queue = await queueOf();
      await operator('asha');
      await operator('ben');
      const ticket = await open(queue);
      expect(await tickets().context(ticket.id, { operatorId: 'asha' })).toBe('forbidden');
      await accept(ticket, 'asha');
      expect(await tickets().context(ticket.id, { operatorId: 'ben' })).toBe('forbidden');
      expect(await tickets().context(ticket.id, { operatorId: 'asha' })).toEqual(
        expect.objectContaining({
          summary: 'Caller asks about a charge.',
          caller: { number: '+919800000000' },
        }),
      );
      expect(
        await tickets().context('00000000-0000-4000-8000-000000000000', { operatorId: 'asha' }),
      ).toBeUndefined();
    });

    it('gives the context to a bearer token for its time, and only that ticket', async () => {
      const queue = await h.service.queues.create(externalDefinition());
      const ticket = await open(queue);
      const other = await open(queue);
      const token = await tickets().issueContextToken(ticket.id, 900);
      expect(token.length).toBeGreaterThanOrEqual(32);
      expect(await tickets().context(ticket.id, { token })).toMatchObject({
        brief: expect.any(String),
      });
      expect(await tickets().context(other.id, { token })).toBe('forbidden');
      expect(await tickets().context(ticket.id, { token: 'nope' })).toBe('forbidden');
      expect(await tickets().context(ticket.id, { token: `${token}x` })).toBe('forbidden');
      h.clock.advance(899_000);
      expect(await tickets().context(ticket.id, { token })).toMatchObject({
        brief: expect.any(String),
      });
      h.clock.advance(1_000);
      expect(await tickets().context(ticket.id, { token })).toBe('expired');
      const fresh = await tickets().issueContextToken(ticket.id, 60);
      expect(fresh).not.toBe(token);
      expect(await tickets().context(ticket.id, { token })).toBe('forbidden');
      expect(await tickets().context(ticket.id, { token: fresh })).toMatchObject({
        brief: expect.any(String),
      });
      await expect(
        tickets().issueContextToken('00000000-0000-4000-8000-000000000000', 60),
      ).rejects.toThrow();
      expect(
        await tickets().context('00000000-0000-4000-8000-000000000000', { token }),
      ).toBeUndefined();
    });

    it('nulls the token and caller number with the context', async () => {
      const queue = await h.service.queues.create(externalDefinition());
      const ticket = await open(queue, { contextRetentionHours: 0 });
      const token = await tickets().issueContextToken(ticket.id, 900);
      await tickets().markHandedOff(ticket.id);
      expect(await tickets().context(ticket.id, { token })).toBe('forbidden');
      const view = (await tickets().changes(0, 'nobody')).items;
      expect(view).toEqual([]);
    });

    it('feeds operators the tickets that changed in their domain, oldest change first, any status', async () => {
      const queue = await queueOf({ teamIds: ['support'] });
      const sales = await queueOf({ teamIds: ['sales'] });
      await operator('asha', { teamIds: ['support'] });
      expect(await tickets().changes(0, 'asha')).toEqual({ items: [], cursor: 0 });
      const a = await open(queue);
      await open(sales);
      const first = await tickets().changes(0, 'asha');
      expect(first.items.map((t) => t.id)).toEqual([a.id]);
      expect(first.cursor).toBeGreaterThan(0);
      expect((await tickets().changes(first.cursor, 'asha')).items).toEqual([]);
      await accept(a, 'asha');
      const second = await tickets().changes(first.cursor, 'asha');
      expect(second.items).toEqual([
        expect.objectContaining({ id: a.id, status: 'accepted', version: 2 }),
      ]);
      expect(second.cursor).toBeGreaterThan(first.cursor);
      await tickets().release({
        workspaceId: ORG,
        ticketId: a.id,
        expectedVersion: 2,
        reason: 'completed',
        idempotencyKey: 'r',
        code: 'completed',
        by: 'worker',
      });
      const third = await tickets().changes(second.cursor, 'asha');
      expect(third.items).toEqual([
        expect.objectContaining({ id: a.id, status: 'released', releaseCode: 'completed' }),
      ]);
      // A heartbeat is not a change.
      await tickets().workerBeat(a.id);
      expect((await tickets().changes(third.cursor, 'asha')).items).toEqual([]);
      // The cursor moves past changes the operator cannot see.
      const hidden = await open(sales);
      const past = await tickets().changes(third.cursor, 'asha');
      expect(past.items).toEqual([]);
      expect(past.cursor).toBeGreaterThan(third.cursor);
      expect(hidden.id).toBeTruthy();
    });

    it('flags in the feed the ticket offered to the operator', async () => {
      const queue = await queueOf({ assignment: 'AUTO_ASSIGN' });
      await operator('asha');
      const before = (await tickets().changes(0, 'asha')).cursor;
      const ticket = await open(queue);
      const feed = await tickets().changes(before, 'asha');
      expect(feed.items).toEqual([expect.objectContaining({ id: ticket.id, offeredToMe: true })]);
    });
  });
}
