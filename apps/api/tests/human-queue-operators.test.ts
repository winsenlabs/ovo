import { fakeMediaRoom } from '@winsendotai/ovo-conformance/drivers';
import { describe, expect, it } from 'vitest';
import { useHq } from './human-queue-fixtures.ts';
import { makeQueue, managed, openTicket, profile } from './human-queue-data.ts';

const make = useHq(fakeMediaRoom);

describe('operator profiles', () => {
  const users = [
    { id: 'asha', email: 'asha@example.test', label: 'Asha', disabled: false },
    { id: 'old', email: 'old@example.test', label: 'Old', disabled: true },
  ];

  it('is admin only', async () => {
    const hq = make({ users });
    for (const role of ['viewer', 'editor'] as const) {
      expect((await hq.call('GET', '/v1/human-queues/operators', { role })).statusCode).toBe(403);
      expect(
        (
          await hq.call('PUT', '/v1/human-queues/operators/asha', {
            role,
            payload: profile('asha'),
          })
        ).statusCode,
      ).toBe(403);
    }
  });

  it('saves a profile for an existing user and lists it joined with the directory and presence', async () => {
    const hq = make({ users });
    const saved = await hq.call('PUT', '/v1/human-queues/operators/asha', {
      payload: {
        displayName: 'Asha K',
        enabled: true,
        teamIds: ['support'],
        languages: ['en', 'hi'],
        capacity: 2,
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    await hq.service.operators.heartbeat('asha', 'AVAILABLE');
    const listed = (await hq.call('GET', '/v1/human-queues/operators')).json();
    expect(listed.items).toEqual([
      expect.objectContaining({
        userId: 'asha',
        displayName: 'Asha K',
        label: 'Asha',
        email: 'asha@example.test',
        userDisabled: false,
        status: 'AVAILABLE',
        capacity: 2,
        active: 0,
      }),
    ]);
    expect(hq.audits.at(-1)).toMatchObject({
      action: 'human_queue.operator.upsert',
      resourceId: 'asha',
    });
  });

  it('refuses an unknown user, and enabling a disabled one', async () => {
    const hq = make({ users });
    const unknown = await hq.call('PUT', '/v1/human-queues/operators/ghost', {
      payload: { displayName: 'G', enabled: true, teamIds: [], languages: [], capacity: 1 },
    });
    expect([unknown.statusCode, unknown.json().error.code]).toEqual([404, 'user_not_found']);
    const disabled = await hq.call('PUT', '/v1/human-queues/operators/old', {
      payload: { displayName: 'O', enabled: true, teamIds: [], languages: [], capacity: 1 },
    });
    expect([disabled.statusCode, disabled.json().error.code]).toEqual([422, 'operator_invalid']);
    const off = await hq.call('PUT', '/v1/human-queues/operators/old', {
      payload: { displayName: 'O', enabled: false, teamIds: [], languages: [], capacity: 1 },
    });
    expect(off.statusCode).toBe(200);
  });

  it('answers 422 for an invalid profile, and ignores a userId in the body that disagrees', async () => {
    const hq = make({ users });
    const bad = await hq.call('PUT', '/v1/human-queues/operators/asha', {
      payload: {
        displayName: 'A',
        enabled: true,
        teamIds: ['Not Valid'],
        languages: [],
        capacity: 99,
      },
    });
    expect([bad.statusCode, bad.json().error.code]).toEqual([422, 'operator_invalid']);
    expect(bad.json().issues.length).toBeGreaterThanOrEqual(2);
    const ok = await hq.call('PUT', '/v1/human-queues/operators/asha', {
      payload: {
        userId: 'someone-else',
        displayName: 'A',
        enabled: true,
        teamIds: [],
        languages: [],
        capacity: 1,
      },
    });
    expect(ok.json().userId).toBe('asha');
  });
});

describe('force-releasing a ticket', () => {
  it('releases a waiting ticket as an admin and audits it', async () => {
    const hq = make();
    const queue = await makeQueue(hq, managed());
    const ticket = await openTicket(hq, queue);
    const response = await hq.call('POST', `/v1/human-queues/tickets/${ticket.id}/release`);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      id: ticket.id,
      status: 'released',
      releaseCode: 'operator_left',
    });
    expect(hq.audits.at(-1)).toMatchObject({
      action: 'human_queue.ticket.force_release',
      resourceId: ticket.id,
    });
  });

  it('is admin only, 404s an unknown ticket and is idempotent on an ended one', async () => {
    const hq = make();
    const queue = await makeQueue(hq, managed());
    const ticket = await openTicket(hq, queue);
    expect(
      (await hq.call('POST', `/v1/human-queues/tickets/${ticket.id}/release`, { role: 'editor' }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await hq.call(
          'POST',
          '/v1/human-queues/tickets/00000000-0000-4000-8000-000000000009/release',
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await hq.call('POST', `/v1/human-queues/tickets/${ticket.id}/release`)).statusCode,
    ).toBe(200);
    expect(
      (await hq.call('POST', `/v1/human-queues/tickets/${ticket.id}/release`)).statusCode,
    ).toBe(200);
  });
});
