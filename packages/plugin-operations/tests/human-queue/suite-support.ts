import { describe, expect, it } from 'vitest';
import { useHarness, ticketKit, ORG, T0, context, type HqHarness } from './harness.ts';
import type { Ticket } from '../../src/human-queue/service.ts';

export function describeSupport(make: () => Promise<HqHarness>) {
  const h = useHarness(make);
  const { tickets, queueOf, operator, open, accept, get } = ticketKit(h);

  describe('worker liveness, commands and wrap-up', () => {
    it('releases an active ticket as worker_lost when the worker stops beating', async () => {
      const queue = await queueOf();
      await operator('asha');
      const waiting = await open(queue);
      const taken = (await accept(await open(queue), 'asha')) as Ticket;
      h.clock.advance(15_000);
      await tickets().workerBeat(taken.id);
      await tickets().workerBeat(waiting.id);
      h.clock.advance(15_000);
      expect(await h.service.sweep(h.clock.now())).toMatchObject({ stale: 0 });
      h.clock.advance(6_000);
      await tickets().workerBeat(taken.id);
      expect(await h.service.sweep(h.clock.now())).toMatchObject({ stale: 1 });
      expect(await get(waiting.id)).toMatchObject({
        status: 'released',
        releaseCode: 'worker_lost',
        outcome: 'failed',
      });
      expect(await get(taken.id)).toMatchObject({ status: 'accepted' });
      await tickets().workerBeat(waiting.id);
      expect((await get(waiting.id)).status).toBe('released');
    });

    it('carries one command at a time from the assigned operator, acked by the worker', async () => {
      const queue = await queueOf();
      await operator('asha');
      await operator('ben');
      const ticket = (await accept(await open(queue), 'asha')) as Ticket;
      expect(await tickets().setCommand(ticket.id, 'ben', { kind: 'end_call' })).toBe('forbidden');
      expect(
        await tickets().setCommand('00000000-0000-4000-8000-000000000000', 'asha', {
          kind: 'end_call',
        }),
      ).toBe('conflict');
      expect(
        await tickets().setCommand(ticket.id, 'asha', {
          kind: 'return_to_agent',
          target: 'support',
        }),
      ).toBe(1);
      expect((await get(ticket.id)).command).toEqual({
        seq: 1,
        ack: 0,
        body: { kind: 'return_to_agent', target: 'support' },
      });
      expect(await tickets().setCommand(ticket.id, 'asha', { kind: 'end_call' })).toBe(2);
      await tickets().ackCommand(ticket.id, 1);
      expect((await get(ticket.id)).command).toEqual({
        seq: 2,
        ack: 1,
        body: { kind: 'end_call' },
      });
      await tickets().ackCommand(ticket.id, 2);
      await tickets().ackCommand(ticket.id, 1);
      await tickets().ackCommand(ticket.id, 99);
      expect((await get(ticket.id)).command).toMatchObject({ seq: 2, ack: 2 });
    });

    it('refuses a command on a ticket that is not accepted', async () => {
      const queue = await queueOf();
      await operator('asha');
      const ticket = await open(queue);
      expect(await tickets().setCommand(ticket.id, 'asha', { kind: 'end_call' })).toBe('conflict');
    });

    it('marks the operator connected once, and counts talk from it', async () => {
      const queue = await queueOf();
      await operator('asha');
      const ticket = (await accept(await open(queue), 'asha')) as Ticket;
      expect(ticket.connectedAt).toBeUndefined();
      h.clock.advance(3_000);
      await tickets().markConnected(ticket.id);
      h.clock.advance(3_000);
      await tickets().markConnected(ticket.id);
      expect((await get(ticket.id)).connectedAt).toBe(new Date(T0.getTime() + 3_000).toISOString());
    });

    it('takes a wrap-up from the assigned operator until the context is scrubbed', async () => {
      const queue = await queueOf();
      await operator('asha');
      await operator('ben');
      const ticket = (await accept(
        await open(queue, { contextRetentionHours: 1 }),
        'asha',
      )) as Ticket;
      expect(await tickets().setWrapUp(ticket.id, 'ben', { disposition: 'resolved' })).toBe(false);
      expect(
        await tickets().setWrapUp(ticket.id, 'asha', { disposition: 'resolved', note: 'ok' }),
      ).toBe(true);
      expect((await get(ticket.id)).wrapUp).toEqual({ disposition: 'resolved', note: 'ok' });
      await tickets().release({
        workspaceId: ORG,
        ticketId: ticket.id,
        expectedVersion: 2,
        reason: 'completed',
        idempotencyKey: 'r',
        code: 'completed',
        by: 'operator',
      });
      expect(await tickets().setWrapUp(ticket.id, 'asha', { disposition: 'escalated' })).toBe(true);
      h.clock.advance(3_600_000);
      await h.service.sweep(h.clock.now());
      expect(await tickets().setWrapUp(ticket.id, 'asha', { disposition: 'late' })).toBe(false);
      expect(await tickets().setWrapUp('00000000-0000-4000-8000-000000000000', 'asha', {})).toBe(
        false,
      );
    });
  });

  describe('sweep', () => {
    it('expires waiting and offered tickets past their deadline, never an accepted one', async () => {
      const queue = await queueOf({ assignment: 'AUTO_ASSIGN' });
      await operator('asha');
      const offered = await open(queue, { offerSeconds: 600 });
      const waiting = await open(queue);
      const accepted = (await accept(offered, 'asha')) as Ticket;
      const other = await open(await queueOf());
      for (let i = 0; i < 12; i += 1) {
        h.clock.advance(15_000);
        for (const t of [waiting, accepted, other]) await tickets().workerBeat(t.id);
        await h.service.operators.heartbeat('asha');
      }
      const result = await h.service.sweep(h.clock.now());
      expect(result).toMatchObject({ expired: 2, stale: 0 });
      expect(await get(waiting.id)).toMatchObject({
        status: 'expired',
        releaseCode: 'timed_out',
        outcome: 'timeout',
      });
      expect(await get(other.id)).toMatchObject({ status: 'expired' });
      expect(await get(accepted.id)).toMatchObject({ status: 'accepted' });
      expect((await h.events(waiting.id)).at(-1)!.payload).toMatchObject({
        state: 'expired',
        by: 'sweeper',
        code: 'timed_out',
      });
      expect(await h.service.sweep(h.clock.now())).toEqual({
        assigned: 0,
        expired: 0,
        reoffered: 0,
        scrubbed: 0,
        stale: 0,
      });
    });

    it('does nothing to a quiet system and is safe to run twice', async () => {
      expect(await h.service.sweep(h.clock.now())).toEqual({
        assigned: 0,
        expired: 0,
        reoffered: 0,
        scrubbed: 0,
        stale: 0,
      });
      const queue = await queueOf();
      const ticket = await open(queue);
      await h.service.sweep(h.clock.now());
      await h.service.sweep(h.clock.now());
      expect(await get(ticket.id)).toMatchObject({ status: 'waiting', version: 1 });
    });
  });
}
