import { describe, expect, it } from 'vitest';
import { useHarness, ticketKit, next, type HqHarness } from './harness.ts';

export function describeAssign(make: () => Promise<HqHarness>) {
  const h = useHarness(make);
  const { queueOf, operator, open, accept, get } = ticketKit(h);

  describe('AUTO_ASSIGN', () => {
    it('offers by language match, then lightest load, then longest idle, then id', async () => {
      const queue = await queueOf({ assignment: 'AUTO_ASSIGN', language: 'prefer' });
      await operator('a', { languages: ['en'], capacity: 3 });
      await operator('b', { languages: ['hi'], capacity: 3 });
      await operator('c', { languages: ['hi'], capacity: 3 });
      const first = await open(queue, { language: 'hi' });
      expect(first.assignedOperatorId).toBe('b'); // hi speakers first; ids break the tie
      h.clock.advance(1_000);
      const second = await open(queue, { language: 'hi' });
      expect(second.assignedOperatorId).toBe('c'); // b already holds one
      h.clock.advance(1_000);
      const third = await open(queue, { language: 'hi' });
      expect(third.assignedOperatorId).toBe('b'); // equal load: b was assigned longest ago
      const english = await open(queue, { language: 'en' });
      expect(english.assignedOperatorId).toBe('a'); // en speaker first
    });

    it('never offers beyond capacity, to a declined operator, or to someone offline', async () => {
      const queue = await queueOf({ assignment: 'AUTO_ASSIGN', language: 'require' });
      await operator('en', { languages: ['en'] });
      await operator('hi', { languages: ['hi'] });
      await operator('away', { languages: ['hi'] }, 'AWAY');
      const a = await open(queue, { language: 'hi' });
      expect(a.assignedOperatorId).toBe('hi');
      const b = await open(queue, { language: 'hi' });
      expect(b).toMatchObject({ status: 'waiting' }); // hi is full, away is not online
      const c = await open(queue, { language: 'fr' });
      expect(c).toMatchObject({ status: 'waiting' }); // nobody speaks it
    });

    it('offers a waiting ticket as soon as the sweeper finds an operator', async () => {
      const queue = await queueOf({ assignment: 'AUTO_ASSIGN' });
      const ticket = await open(queue);
      expect(ticket.status).toBe('waiting');
      expect(await h.service.sweep(h.clock.now())).toMatchObject({ assigned: 0 });
      await operator('asha');
      expect(await h.service.sweep(h.clock.now())).toMatchObject({ assigned: 1 });
      expect(await get(ticket.id)).toMatchObject({
        status: 'offered',
        assignedOperatorId: 'asha',
        version: 2,
      });
    });

    it('serves higher priority first, then the longest waiting', async () => {
      const queue = await queueOf({ assignment: 'AUTO_ASSIGN' });
      const first = await open(queue);
      h.clock.advance(1_000);
      const second = await open(queue);
      h.clock.advance(1_000);
      const urgent = await open(queue, { priority: 9 });
      await operator('asha');
      expect((await h.service.sweep(h.clock.now())).assigned).toBe(1);
      expect(await get(urgent.id)).toMatchObject({ status: 'offered' });
      expect(await get(first.id)).toMatchObject({ status: 'waiting' });
      await operator('ben');
      await h.service.sweep(h.clock.now());
      expect(await get(first.id)).toMatchObject({ status: 'offered', assignedOperatorId: 'ben' });
      expect(await get(second.id)).toMatchObject({ status: 'waiting' });
    });

    it('rotates a lapsed offer to the next operator and never back to the one who let it lapse', async () => {
      const queue = await queueOf({ assignment: 'AUTO_ASSIGN', offerSeconds: 10 });
      await operator('asha');
      await operator('ben');
      const ticket = await open(queue, { offerSeconds: 10 });
      expect(ticket.assignedOperatorId).toBe('asha');
      h.clock.advance(9_000);
      expect(await h.service.sweep(h.clock.now())).toMatchObject({ reoffered: 0 });
      h.clock.advance(1_000);
      await h.service.operators.heartbeat('asha');
      await h.service.operators.heartbeat('ben');
      expect(await h.service.sweep(h.clock.now())).toMatchObject({ reoffered: 1, assigned: 1 });
      const second = await get(ticket.id);
      expect(second).toMatchObject({ status: 'offered', assignedOperatorId: 'ben' });
      expect(second.offerExpiresAt).toBe(new Date(h.clock.now().getTime() + 10_000).toISOString());
      h.clock.advance(10_000);
      await h.service.operators.heartbeat('asha');
      await h.service.operators.heartbeat('ben');
      expect(await h.service.sweep(h.clock.now())).toMatchObject({ reoffered: 1, assigned: 0 });
      expect(await get(ticket.id)).toMatchObject({ status: 'waiting' });
    });

    it('lets the offered operator accept, and nobody else', async () => {
      const queue = await queueOf({ assignment: 'AUTO_ASSIGN' });
      await operator('asha');
      await operator('ben');
      const ticket = await open(queue);
      expect(await accept(ticket, 'ben')).toEqual({ kind: 'not_eligible' });
      expect(await accept(ticket, 'asha')).toMatchObject({ status: 'accepted' });
    });
  });
}
