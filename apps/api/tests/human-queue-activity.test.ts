import { fakeMediaRoom } from '@winsendotai/ovo-conformance/drivers';
import { describe, expect, it } from 'vitest';
import { QueueActivity } from '@winsendotai/ovo-contracts';
import { useHq } from './human-queue-fixtures.ts';
import { external, makeQueue, managed, onlineOperator, openTicket } from './human-queue-data.ts';

const make = useHq(fakeMediaRoom);
const viewer = { role: 'viewer' as const };
const MISSING = '99999999-9999-4999-8999-999999999999';

describe('GET /v1/human-queues/:id/activity (R4)', () => {
  it('reports what the queue did in the window, from the service, to a viewer', async () => {
    const hq = make();
    const queue = await makeQueue(hq, managed({ name: 'Floor' }));
    await onlineOperator(hq, 'asha');
    const answered = await openTicket(hq, queue);
    await openTicket(hq, queue, { language: 'hi' });
    hq.service.clock.advance(20_000);
    const taken = await hq.service.tickets.accept({
      workspaceId: 'ws-hq',
      ticketId: answered.id,
      operatorId: 'asha',
      expectedVersion: answered.version,
      idempotencyKey: 'accept-1',
    });
    expect(taken).toMatchObject({ status: 'accepted' });

    const response = await hq.call('GET', `/v1/human-queues/${queue.id}/activity`, viewer);
    expect(response.statusCode, response.body).toBe(200);
    const body = QueueActivity.parse(response.json());
    expect(body).toMatchObject({
      queueId: queue.id,
      window: '24h',
      stats: { created: 2, handled: 1, avgWaitMs: 20_000, abandoned: 0, expired: 0 },
    });
    expect(body.tickets).toHaveLength(2);
    expect(body.tickets.find((ticket) => ticket.id === answered.id)).toMatchObject({
      status: 'accepted',
      operatorId: 'asha',
      waitMs: 20_000,
    });
    // Never a number, a summary or a context, whatever the ticket holds.
    expect(response.body).not.toMatch(/\+91|charge|brief|transcript|variables/);
    const week = await hq.call('GET', `/v1/human-queues/${queue.id}/activity?window=7d`, viewer);
    expect(week.json().window).toBe('7d');
  });

  it('works for a webhook queue and ignores another queue tickets', async () => {
    const hq = make();
    const acd = await makeQueue(hq, external());
    const desk = await makeQueue(hq, managed());
    await openTicket(hq, acd);
    await openTicket(hq, desk);
    await openTicket(hq, desk);
    const body = (await hq.call('GET', `/v1/human-queues/${acd.id}/activity`, viewer)).json();
    expect(body.stats.created).toBe(1);
    expect(body.tickets).toHaveLength(1);
  });

  it('404s an unknown or deleted queue, validates the query and the id', async () => {
    const hq = make();
    const queue = await makeQueue(hq, managed());
    const missing = await hq.call('GET', `/v1/human-queues/${MISSING}/activity`, viewer);
    expect([missing.statusCode, missing.json().error.code]).toEqual([404, 'queue_not_found']);
    for (const query of ['window=30d', 'window=', 'extra=1']) {
      const refused = await hq.call(
        'GET',
        `/v1/human-queues/${queue.id}/activity?${query}`,
        viewer,
      );
      expect([refused.statusCode, refused.json().error.code], query).toEqual([
        422,
        'queue_activity_invalid',
      ]);
    }
    expect((await hq.call('GET', '/v1/human-queues/not-a-uuid/activity', viewer)).statusCode).toBe(
      400,
    );
    expect(
      (await hq.call('DELETE', `/v1/human-queues/${queue.id}`, { headers: { 'if-match': '"1"' } }))
        .statusCode,
    ).toBe(204);
    expect((await hq.call('GET', `/v1/human-queues/${queue.id}/activity`, viewer)).statusCode).toBe(
      404,
    );
  });

  it('is dark with the rest of the feature: 404 human_queue_disabled', async () => {
    const hq = make({ enabled: false });
    const response = await hq.call('GET', `/v1/human-queues/${MISSING}/activity`, viewer);
    expect([response.statusCode, response.json().error.code]).toEqual([
      404,
      'human_queue_disabled',
    ]);
  });
});
