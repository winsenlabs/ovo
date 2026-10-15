import { afterEach, describe, expect, it } from 'vitest';
import {
  external,
  humanQueueApp,
  makeQueue,
  managed,
  onlineOperator,
  openTicket,
  profile,
  type HqApp,
} from './human-queue-fixtures.ts';

const apps: HqApp[] = [];
const make = (options: Parameters<typeof humanQueueApp>[0] = {}) => {
  const built = humanQueueApp(options);
  apps.push(built);
  return built;
};
afterEach(async () => Promise.all(apps.splice(0).map((hq) => hq.app.close())));

const issueCodes = (body: { issues: { code?: string }[] }) =>
  body.issues.map((issue) => issue.code);

describe('creating a queue', () => {
  it('creates a desk queue with defaults filled in, a version etag and an audit entry', async () => {
    const hq = make();
    const response = await hq.call('POST', '/v1/human-queues', {
      role: 'editor',
      payload: { definition: managed({ name: 'Floor' }) },
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.headers.etag).toBe('"1"');
    const body = response.json();
    expect(body.definition).toMatchObject({
      kind: 'managed',
      name: 'Floor',
      assignment: 'OPEN_PICKUP',
      offerSeconds: 20,
      joinSeconds: 25,
      requireOnline: true,
      limits: { maxWaiting: 100 },
      context: { callerId: true, transcriptTurns: 6 },
    });
    expect(hq.audits.at(-1)).toMatchObject({ action: 'human_queue.create', resourceId: body.id });
  });

  it('creates a webhook queue whose credentials exist', async () => {
    const hq = make();
    const response = await hq.call('POST', '/v1/human-queues', {
      payload: { definition: external() },
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().definition.context.callerId).toBe(false);
  });

  it('refuses a viewer', async () => {
    const hq = make();
    const response = await hq.call('POST', '/v1/human-queues', {
      role: 'viewer',
      payload: { definition: managed() },
    });
    expect([response.statusCode, response.json().error.code]).toEqual([403, 'forbidden']);
  });

  it('answers 422 with issue lists for a schema problem', async () => {
    const hq = make();
    const response = await hq.call('POST', '/v1/human-queues', {
      payload: { definition: managed({ offerSeconds: 2, teamIds: ['Bad Team'] }) },
    });
    expect(response.statusCode).toBe(422);
    const body = response.json();
    expect(body.error.code).toBe('queue_invalid');
    expect(body.issues.map((issue: { path: unknown[] }) => issue.path.join('.')).sort()).toEqual([
      'offerSeconds',
      'teamIds.0',
    ]);
    expect(body.issues[0]).toEqual(expect.objectContaining({ message: expect.any(String) }));
  });

  it('answers 422 for an envelope that is not { definition }', async () => {
    const hq = make();
    const response = await hq.call('POST', '/v1/human-queues', {
      payload: { definition: managed(), extra: 1 },
    });
    expect([response.statusCode, response.json().error.code]).toEqual([422, 'queue_invalid']);
  });

  it('refuses a webhook endpoint that is not public https', async () => {
    const hq = make();
    for (const url of [
      'http://acd.example.com/h',
      'https://user:pw@acd.example.com/h',
      'https://127.0.0.1/h',
      'https://localhost/h',
    ]) {
      const response = await hq.call('POST', '/v1/human-queues', {
        payload: { definition: external({ webhook: { url, credentialId: 'acd-hmac' } }) },
      });
      expect(response.statusCode, url).toBe(422);
      expect(issueCodes(response.json()), url).toContain('routing_queue_endpoint_invalid');
    }
  });

  it('refuses credentials that do not exist, for the secret and for the extra auth', async () => {
    const hq = make();
    const response = await hq.call('POST', '/v1/human-queues', {
      payload: {
        definition: external({
          webhook: {
            url: 'https://acd.example.com/h',
            credentialId: 'nope',
            auth: { kind: 'header', name: 'X-Api-Key', credentialId: 'also-nope' },
          },
        }),
      },
    });
    expect(response.statusCode).toBe(422);
    expect(
      response
        .json()
        .issues.filter((i: { code?: string }) => i.code === 'routing_queue_credential_missing')
        .map((i: { path: unknown[] }) => i.path.join('.'))
        .sort(),
    ).toEqual(['webhook.auth.credentialId', 'webhook.credentialId']);
  });

  it('refuses a mapping that reads a field the context policy switches off', async () => {
    const hq = make();
    const response = await hq.call('POST', '/v1/human-queues', {
      payload: {
        definition: external({
          webhook: {
            url: 'https://acd.example.com/h',
            credentialId: 'acd-hmac',
            body: { ani: { $from: 'caller.number' } },
          },
        }),
      },
    });
    expect(response.statusCode).toBe(422);
    const issue = response
      .json()
      .issues.find((i: { code?: string }) => i.code === 'routing_queue_mapping_field_disabled');
    expect(issue.path.slice(0, 3)).toEqual(['webhook', 'body', 'ani']);
  });

  it('refuses a webhook queue with no destination allow-list', async () => {
    const hq = make();
    const response = await hq.call('POST', '/v1/human-queues', {
      payload: { definition: external({ destination: { allowE164Prefixes: [] } }) },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().issues[0].path).toEqual(['destination', 'allowE164Prefixes']);
  });

  it('refuses a second queue with the same name, ignoring case', async () => {
    const hq = make();
    await hq.call('POST', '/v1/human-queues', {
      payload: { definition: managed({ name: 'Floor' }) },
    });
    const again = await hq.call('POST', '/v1/human-queues', {
      payload: { definition: managed({ name: 'FLOOR' }) },
    });
    expect([again.statusCode, again.json().error.code]).toEqual([409, 'queue_name_taken']);
  });
});

describe('reading queues', () => {
  it('lists queues with their live numbers and who binds them', async () => {
    const hq = make();
    const queue = await makeQueue(hq, managed({ name: 'Floor' }));
    hq.service.bindPoint('point-1', [queue.id]);
    await onlineOperator(hq, 'asha');
    await openTicket(hq, queue);
    const page = (await hq.call('GET', '/v1/human-queues', { role: 'viewer' })).json();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: queue.id,
      usedBy: ['point-1'],
      stats: { waiting: 1, online: 1 },
    });
    expect(page).toHaveProperty('nextCursor');
  });

  it('pages by queue id', async () => {
    const hq = make();
    for (let i = 0; i < 3; i += 1) await makeQueue(hq, managed());
    const first = (await hq.call('GET', '/v1/human-queues?limit=2')).json();
    expect(first.items).toHaveLength(2);
    const second = (
      await hq.call('GET', `/v1/human-queues?limit=2&cursor=${first.nextCursor}`)
    ).json();
    expect(second.items).toHaveLength(1);
  });

  it('reads one queue with its etag, and 404s an unknown one', async () => {
    const hq = make();
    const queue = await makeQueue(hq, managed());
    const found = await hq.call('GET', `/v1/human-queues/${queue.id}`, { role: 'viewer' });
    expect([found.statusCode, found.headers.etag]).toEqual([200, '"1"']);
    const missing = await hq.call('GET', '/v1/human-queues/00000000-0000-4000-8000-000000000009');
    expect([missing.statusCode, missing.json().error.code]).toEqual([404, 'queue_not_found']);
    expect((await hq.call('GET', '/v1/human-queues/not-a-uuid')).statusCode).toBe(400);
  });
});

describe('updating a queue', () => {
  it('updates behind If-Match and bumps the version', async () => {
    const hq = make();
    const queue = await makeQueue(hq, managed({ name: 'Floor' }));
    const response = await hq.call('PUT', `/v1/human-queues/${queue.id}`, {
      headers: { 'if-match': '"1"' },
      payload: { definition: managed({ name: 'Floor', offerSeconds: 45 }) },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers.etag).toBe('"2"');
    expect(response.json().definition.offerSeconds).toBe(45);
  });

  it('answers 428 without If-Match, and 409 with the current row when stale', async () => {
    const hq = make();
    const queue = await makeQueue(hq, managed());
    const missing = await hq.call('PUT', `/v1/human-queues/${queue.id}`, {
      payload: { definition: managed() },
    });
    expect(missing.statusCode).toBe(428);
    const stale = await hq.call('PUT', `/v1/human-queues/${queue.id}`, {
      headers: { 'if-match': '"7"' },
      payload: { definition: managed({ name: queue.definition.name }) },
    });
    expect([stale.statusCode, stale.json().error.code]).toEqual([409, 'queue_conflict']);
    expect(stale.json().current.version).toBe(1);
  });

  it('does not let a queue change type, and validates like create', async () => {
    const hq = make();
    const queue = await makeQueue(hq, managed());
    const swapped = await hq.call('PUT', `/v1/human-queues/${queue.id}`, {
      headers: { 'if-match': '"1"' },
      payload: { definition: external() },
    });
    expect(swapped.statusCode).toBe(422);
    expect(swapped.json().issues[0].path).toEqual(['kind']);
    const bad = await hq.call('PUT', `/v1/human-queues/${queue.id}`, {
      headers: { 'if-match': '"1"' },
      payload: { definition: managed({ joinSeconds: 1 }) },
    });
    expect(bad.statusCode).toBe(422);
  });

  it('404s an unknown queue before anything else', async () => {
    const hq = make();
    const response = await hq.call('PUT', '/v1/human-queues/00000000-0000-4000-8000-000000000009', {
      headers: { 'if-match': '"1"' },
      payload: { definition: managed() },
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses a name another queue already has', async () => {
    const hq = make();
    await makeQueue(hq, managed({ name: 'Taken' }));
    const queue = await makeQueue(hq, managed({ name: 'Mine' }));
    const response = await hq.call('PUT', `/v1/human-queues/${queue.id}`, {
      headers: { 'if-match': '"1"' },
      payload: { definition: managed({ name: 'taken' }) },
    });
    expect([response.statusCode, response.json().error.code]).toEqual([409, 'queue_name_taken']);
  });
});

describe('deleting a queue', () => {
  it('deletes behind If-Match and audits it', async () => {
    const hq = make();
    const queue = await makeQueue(hq, managed());
    const response = await hq.call('DELETE', `/v1/human-queues/${queue.id}`, {
      headers: { 'if-match': '"1"' },
    });
    expect(response.statusCode).toBe(204);
    expect((await hq.call('GET', `/v1/human-queues/${queue.id}`)).statusCode).toBe(404);
    expect(hq.audits.at(-1)).toMatchObject({ action: 'human_queue.delete', resourceId: queue.id });
  });

  it('refuses while a routing point binds it, naming the points', async () => {
    const hq = make();
    const queue = await makeQueue(hq, managed());
    hq.service.bindPoint('point-9', [queue.id]);
    const response = await hq.call('DELETE', `/v1/human-queues/${queue.id}`, {
      headers: { 'if-match': '"1"' },
    });
    expect([response.statusCode, response.json().error.code, response.json().inUseBy]).toEqual([
      409,
      'queue_in_use',
      ['point-9'],
    ]);
  });

  it('answers 409 with the row when the version is stale, 404 when it is gone', async () => {
    const hq = make();
    const queue = await makeQueue(hq, managed());
    const stale = await hq.call('DELETE', `/v1/human-queues/${queue.id}`, {
      headers: { 'if-match': '"4"' },
    });
    expect([stale.statusCode, stale.json().error.code]).toEqual([409, 'queue_conflict']);
    await hq.call('DELETE', `/v1/human-queues/${queue.id}`, { headers: { 'if-match': '"1"' } });
    expect(
      (await hq.call('DELETE', `/v1/human-queues/${queue.id}`, { headers: { 'if-match': '"1"' } }))
        .statusCode,
    ).toBe(404);
  });

  it('is not open to a viewer', async () => {
    const hq = make();
    const queue = await makeQueue(hq, managed());
    expect(
      (
        await hq.call('DELETE', `/v1/human-queues/${queue.id}`, {
          role: 'viewer',
          headers: { 'if-match': '"1"' },
        })
      ).statusCode,
    ).toBe(403);
  });
});

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
