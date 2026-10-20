import { describe, expect, it } from 'vitest';
import { QueueActivity } from '@winsendotai/ovo-contracts';
import {
  externalDefinition,
  next,
  ticketFor,
  ticketKit,
  useHarness,
  T0,
  type HqHarness,
} from './harness.ts';
import type { Ticket } from '../../src/human-queue/service.ts';

const HOUR = 3_600_000;

export function describeActivity(make: () => Promise<HqHarness>) {
  const h = useHarness(make);
  const { tickets, queueOf, operator, open, accept } = ticketKit(h);
  const release = (
    ticket: Pick<Ticket, 'id' | 'version'>,
    code: 'completed' | 'abandoned' | 'webhook_failed',
    outcome: 'ended' | 'abandoned' | 'failed',
  ) =>
    tickets().release({
      workspaceId: h.org,
      ticketId: ticket.id,
      expectedVersion: ticket.version,
      reason: 'completed',
      idempotencyKey: `r-${next()}`,
      code,
      by: 'worker',
      outcome,
    });

  describe('queue activity and analytics (R4)', () => {
    it('counts what became of the tickets created in the window', async () => {
      const queue = await queueOf();
      await operator('asha');
      await operator('ben');
      // Created at T0: taken and talked, taken and talked longer, dropped, failed, and left to expire.
      const answered = await open(queue, { language: 'hi' });
      const second = await open(queue);
      const dropped = await open(queue);
      const failed = await open(queue);
      const lapsed = await open(queue);
      h.clock.advance(30_000);
      const first = (await accept(answered, 'asha')) as Ticket;
      const other = (await accept(second, 'ben')) as Ticket;
      await tickets().markConnected(answered.id);
      h.clock.advance(10_000);
      await tickets().markConnected(second.id);
      h.clock.advance(50_000);
      await release(first, 'completed', 'ended');
      h.clock.advance(60_000);
      await release(other, 'completed', 'ended');
      await release(dropped, 'abandoned', 'abandoned');
      await release(failed, 'webhook_failed', 'failed');
      h.clock.advance(120_000);
      // The lapsed ticket's worker is still there, so the sweeper expires it (not worker_lost).
      await tickets().workerBeat(lapsed.id);
      await h.service.sweep(h.clock.now());

      const day = (await h.service.queues.activity(queue.id, '24h'))!;
      expect(QueueActivity.parse(day)).toBeTruthy();
      // asha waited 30 s and talked 60 s (connected at +30 s, released at +90 s); ben waited 40 s
      // and talked 110 s; the dropped, failed and lapsed tickets were never answered.
      // The lapsed ticket expired by timeout; the failed one is a webhook failure.
      expect(day.stats).toEqual({
        created: 5,
        handled: 2,
        abandoned: 1,
        expired: 1,
        webhookFailed: 1,
        avgWaitMs: 35_000,
        p95WaitMs: 39_500,
        avgTalkMs: 85_000,
        byOutcome: { ended: 2, abandoned: 1, failed: 1, timeout: 1 },
      });
      expect(day.queueId).toBe(queue.id);
      expect(day.window).toBe('24h');
      expect(await h.service.queues.analytics(queue.id, '24h')).toEqual(day.stats);
      expect(day.tickets).toHaveLength(5);
      const row = (id: string) => day.tickets.find((entry) => entry.id === id)!;
      expect(row(answered.id)).toMatchObject({
        callId: answered.callId,
        status: 'released',
        language: 'hi',
        createdAt: T0.toISOString(),
        waitMs: 30_000,
        releaseCode: 'completed',
        outcome: 'ended',
        operatorId: 'asha',
      });
      expect(row(lapsed.id)).toMatchObject({ status: 'expired' });
      expect(row(lapsed.id)).not.toHaveProperty('operatorId');
      // A row carries ids, codes and timings, never the number, summary or context.
      expect(JSON.stringify(day.tickets)).not.toMatch(/\+91|charge|brief|variables|transcript/);
      for (const entry of day.tickets) expect(Object.keys(entry)).not.toContain('context');
    });

    it('reads the window from when a ticket was created, and lists the newest 50', async () => {
      const queue = await queueOf();
      h.clock.set(new Date(T0.getTime() - 30 * HOUR));
      const old = await open(queue, { expiresAt: new Date(T0.getTime() + HOUR).toISOString() });
      h.clock.set(T0);
      for (let i = 0; i < 52; i += 1) {
        h.clock.advance(1_000);
        await open(queue, { expiresAt: new Date(T0.getTime() + HOUR).toISOString() });
      }
      const day = (await h.service.queues.activity(queue.id, '24h'))!;
      expect(day.stats.created).toBe(52);
      expect(day.tickets.map((entry) => entry.id)).not.toContain(old.id);
      expect(day.tickets).toHaveLength(50);
      expect(day.tickets[0]!.createdAt > day.tickets[49]!.createdAt).toBe(true);
      const week = (await h.service.queues.activity(queue.id, '7d'))!;
      expect(week.stats.created).toBe(53);
      expect(week.tickets).toHaveLength(50);
    });

    it('is empty for a quiet queue, with null averages', async () => {
      const queue = await queueOf();
      const quiet = (await h.service.queues.activity(queue.id, '7d'))!;
      expect(quiet.stats).toEqual({
        created: 0,
        handled: 0,
        abandoned: 0,
        expired: 0,
        webhookFailed: 0,
        avgWaitMs: null,
        p95WaitMs: null,
        avgTalkMs: null,
        byOutcome: {},
      });
      expect(quiet.tickets).toEqual([]);
    });

    it('counts a ticket handed to a third party as handled, and only this queue', async () => {
      const external = await h.service.queues.create(externalDefinition());
      const other = await queueOf();
      const ticket = await open(external);
      await open(other);
      h.clock.advance(4_000);
      await tickets().markHandedOff(ticket.id);
      const stats = (await h.service.queues.analytics(external.id, '24h'))!;
      expect(stats).toMatchObject({ created: 1, handled: 1, avgWaitMs: 4_000, avgTalkMs: null });
      expect((await h.service.queues.analytics(other.id, '24h'))!.created).toBe(1);
      expect(ticketFor(external).callId).toBeTruthy();
    });

    it('knows nothing of an unknown or deleted queue', async () => {
      const queue = await queueOf();
      expect(
        await h.service.queues.activity('00000000-0000-4000-8000-000000000000', '24h'),
      ).toBeUndefined();
      expect(await h.service.queues.analytics('not-a-uuid', '24h')).toBeUndefined();
      expect(await h.service.queues.remove(queue.id, 1)).toBe('removed');
      expect(await h.service.queues.activity(queue.id, '24h')).toBeUndefined();
    });
  });
}
