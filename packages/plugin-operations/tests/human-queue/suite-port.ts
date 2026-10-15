import { describe, expect, it } from 'vitest';
import { HumanHandoffTicket, type HumanHandoffRequest } from '@winsendotai/ovo-contracts';
import { PostgresHumanHandoff } from '../../src/human-queue/handoff-port.ts';
import { managedDefinition, profile, useHarness, type HqHarness } from './harness.ts';

/** The contract's `HumanHandoffPort`, over any store: request, presence, accept, release. */
export function describePort(make: () => Promise<HqHarness>) {
  const h = useHarness(make);
  const port = () => new PostgresHumanHandoff(h.service, h.clock.now);
  const request = async (patch: Partial<HumanHandoffRequest> = {}) => {
    const queue = await h.service.queues.create(managedDefinition({ teamIds: ['support'] }));
    return {
      queue,
      input: {
        workspaceId: h.org,
        sessionId: 'session-1',
        idempotencyKey: 'key-1',
        queueId: queue.id,
        mode: 'OPEN_PICKUP' as const,
        summary: 'Caller wants a person about a refund.',
        context: {},
        acceptTimeoutMs: 20_000,
        ...patch,
      } satisfies HumanHandoffRequest,
    };
  };

  describe('HumanHandoffPort', () => {
    it('opens a waiting ticket that the contract schema accepts, idempotently by key', async () => {
      const { input } = await request();
      const first = await port().request(input);
      expect(HumanHandoffTicket.safeParse(first).success).toBe(true);
      expect(first).toMatchObject({
        status: 'waiting',
        version: 1,
        sessionId: 'session-1',
        workspaceId: h.org,
      });
      expect(first.assignedOperatorId).toBeUndefined();
      expect(await port().request(input)).toEqual(first);
      const ticket = await h.service.tickets.get(first.id);
      expect(ticket?.callId).toBe('session-1');
    });

    it('keeps the full summary when no ticket context was given', async () => {
      const { input } = await request();
      const opened = await port().request(input);
      await h.service.operators.upsert(profile('asha', { teamIds: ['support'] }));
      await h.service.operators.heartbeat('asha', 'AVAILABLE');
      await port().accept({
        workspaceId: h.org,
        ticketId: opened.id,
        operatorId: 'asha',
        expectedVersion: 1,
        idempotencyKey: 'a',
      });
      expect(await h.service.tickets.context(opened.id, { operatorId: 'asha' })).toMatchObject({
        summary: 'Caller wants a person about a refund.',
      });
    });

    it('refuses an unknown queue', async () => {
      const { input } = await request({ queueId: '00000000-0000-4000-8000-000000000000' });
      await expect(port().request(input)).rejects.toThrow(/Unknown human queue/);
    });

    it('reports presence in the contract shape', async () => {
      const { input } = await request();
      await h.service.operators.upsert(profile('asha', { teamIds: ['support'], capacity: 2 }));
      await h.service.operators.heartbeat('asha', 'AVAILABLE');
      const presence = await port().presence({ workspaceId: h.org, queueId: input.queueId });
      expect(presence).toEqual([
        expect.objectContaining({
          operatorId: 'asha',
          status: 'AVAILABLE',
          capacity: 2,
          activeAssignments: 0,
        }),
      ]);
    });

    it('lets the first eligible claimant win and refuses a stale version', async () => {
      const { input } = await request();
      const opened = await port().request(input);
      for (const id of ['asha', 'ben']) {
        await h.service.operators.upsert(profile(id, { teamIds: ['support'] }));
        await h.service.operators.heartbeat(id, 'AVAILABLE');
      }
      const claim = (operatorId: string, expectedVersion = 1, key = `k-${operatorId}`) =>
        port().accept({
          workspaceId: h.org,
          ticketId: opened.id,
          operatorId,
          expectedVersion,
          idempotencyKey: key,
        });
      const [a, b] = await Promise.all([claim('asha'), claim('ben')]);
      const winners = [a, b].filter((r) => 'status' in r);
      expect(winners).toHaveLength(1);
      expect(winners[0]).toMatchObject({ status: 'accepted', version: 2 });
      expect(HumanHandoffTicket.safeParse(winners[0]).success).toBe(true);
      expect([a, b].filter((r) => !('status' in r))).toEqual([{ kind: 'conflict' }]);
      // A fresh attempt on the old version loses; the winner's own key replays instead.
      expect(await claim('asha', 1, 'stale')).toEqual({ kind: 'conflict' });
    });

    it('releases with the contract reasons, idempotently, and conflicts on a stale version', async () => {
      const { input } = await request();
      const opened = await port().request(input);
      const release = (
        expectedVersion: number,
        reason: 'completed' | 'declined' | 'timed_out' | 'call_ended',
      ) =>
        port().release({
          workspaceId: h.org,
          ticketId: opened.id,
          expectedVersion,
          reason,
          idempotencyKey: 'r',
        });
      expect(await release(9, 'completed')).toEqual({ kind: 'conflict' });
      const done = await release(1, 'timed_out');
      expect(done).toMatchObject({ status: 'released', version: 2 });
      expect(await release(2, 'completed')).toEqual(done);
      expect((await h.service.tickets.get(opened.id))?.releaseCode).toBe('timed_out');
      for (const reason of ['completed', 'declined', 'call_ended'] as const) {
        const next = await port().request({
          ...input,
          idempotencyKey: `k-${reason}`,
          sessionId: `s-${reason}`,
        });
        expect(
          await port().release({
            workspaceId: h.org,
            ticketId: next.id,
            expectedVersion: 1,
            reason,
            idempotencyKey: 'r',
          }),
        ).toMatchObject({ status: 'released' });
        expect((await h.service.tickets.get(next.id))?.releaseCode).toBe(reason);
      }
    });
  });
}
