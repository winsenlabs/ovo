import { describe, expect, it } from 'vitest';
import { HumanQueueDefinition, HUMAN_METER_KEYS } from '@winsendotai/ovo-contracts';
import { costPolicy, draftInput, POOL_SUPPORT } from './routing-fixtures.ts';
import {
  bound,
  closeAppsAfterEach,
  codes,
  external,
  KEY,
  make,
  managed,
  setup,
  withEmptyAllowList,
} from './routing-queues-support.ts';

closeAppsAfterEach();

describe('a draft that binds a healthy queue', () => {
  it('has only the advisory warnings of an unpriced, unstaffed desk, and publishes', async () => {
    const s = await setup();
    const queue = await make(s, managed());
    const found = await codes(s, bound(queue.id));
    expect(found.sort()).toEqual([
      'routing_queue_meter_unpriced:warning',
      'routing_queue_no_operators:warning',
    ]);
    const point = (await s.call('POST', '/v1/routing/points', { draft: bound(queue.id) })).json();
    const published = await s.call('POST', `/v1/routing/points/${point.id}/releases`, {});
    expect(published.statusCode, published.body).toBe(201);
  });

  it('is clean once the desk is staffed and the human meters are priced', async () => {
    const priced = Object.values(HUMAN_METER_KEYS);
    const s = await setup({
      routerCostPolicy: { ...costPolicy(priced), maxCallSeconds: 1800 } as never,
    });
    const queue = await make(s, managed({ teamIds: ['support'] }));
    await s.queues.operators.upsert({
      userId: 'asha',
      displayName: 'A',
      enabled: true,
      teamIds: ['support'],
      languages: ['en'],
      capacity: 1,
    });
    expect(await codes(s, bound(queue.id))).toEqual([]);
  });
});

describe('publish resolution codes (design 4.8)', () => {
  it('routing_queue_missing: the queue id names nothing', async () => {
    const s = await setup();
    expect(await codes(s, bound('99999999-9999-4999-8999-999999999999'))).toEqual([
      'routing_queue_missing:error',
    ]);
  });

  it('routing_queue_deleted: the queue was deleted', async () => {
    const s = await setup();
    const queue = await make(s, managed());
    await s.queues.queues.remove(queue.id, 1);
    expect(await codes(s, bound(queue.id))).toEqual(['routing_queue_deleted:error']);
  });

  it('routing_queue_disabled: a warning while the master flag is off', async () => {
    const s = await setup({ humanQueueEnabled: false });
    const queue = await make(s, managed());
    expect(await codes(s, bound(queue.id))).toContain('routing_queue_disabled:warning');
  });

  it('routing_queue_transfer_required: a warning while transfers are off', async () => {
    const s = await setup({ transferEnabled: false });
    const queue = await make(s, managed());
    expect(await codes(s, bound(queue.id))).toContain('routing_queue_transfer_required:warning');
  });

  it('routing_queue_webhook_disabled: a warning for a webhook queue while webhooks are off', async () => {
    const s = await setup({ humanQueueWebhookEnabled: false });
    const queue = await make(s, external());
    const found = await codes(s, bound(queue.id));
    expect(found).toContain('routing_queue_webhook_disabled:warning');
    const on = await setup();
    expect(await codes(on, bound((await make(on, external())).id))).not.toContain(
      'routing_queue_webhook_disabled:warning',
    );
  });

  it('routing_queue_endpoint_invalid: an error for an endpoint that is not public https', async () => {
    const s = await setup();
    const queue = await make(
      s,
      external({ webhook: { url: 'http://acd.example.com/h', credentialId: 'acd-hmac' } }),
    );
    expect(await codes(s, bound(queue.id))).toContain('routing_queue_endpoint_invalid:error');
  });

  it('routing_queue_credential_missing: missing, or not permitted for the router agent, for the secret and the extra auth', async () => {
    const s = await setup();
    const missing = await make(
      s,
      external({ webhook: { url: 'https://acd.example.com/h', credentialId: 'nope' } }),
    );
    expect(await codes(s, bound(missing.id))).toContain('routing_queue_credential_missing:error');
    const restricted = await make(
      s,
      external({ webhook: { url: 'https://acd.example.com/h', credentialId: 'restricted' } }),
    );
    expect(await codes(s, bound(restricted.id))).toContain(
      'routing_queue_credential_missing:error',
    );
    const auth = await make(
      s,
      external({
        webhook: {
          url: 'https://acd.example.com/h',
          credentialId: 'acd-hmac',
          auth: { kind: 'bearer', credentialId: 'nope' },
        },
      }),
    );
    expect(await codes(s, bound(auth.id))).toEqual(
      expect.arrayContaining(['routing_queue_credential_missing:error']),
    );
    const fine = await make(
      s,
      external({
        webhook: {
          url: 'https://acd.example.com/h',
          credentialId: 'acd-hmac',
          auth: { kind: 'bearer', credentialId: 'acd-key' },
        },
      }),
    );
    expect(await codes(s, bound(fine.id))).not.toContain('routing_queue_credential_missing:error');
  });

  it('routing_queue_destination_policy_empty: an error for a webhook queue that allows nothing', async () => {
    const s = await setup();
    const queue = await withEmptyAllowList(s);
    expect(await codes(s, bound(queue.id))).toContain(
      'routing_queue_destination_policy_empty:error',
    );
  });

  it('routing_queue_mapping_invalid and routing_queue_mapping_field_disabled: errors from the mapping', async () => {
    const s = await setup();
    const unknown = await make(
      s,
      external({
        webhook: {
          url: 'https://acd.example.com/h',
          credentialId: 'acd-hmac',
          body: { x: { $from: 'caller.bogus' } },
        },
      }),
    );
    expect(await codes(s, bound(unknown.id))).toContain('routing_queue_mapping_invalid:error');
    const disabled = await make(
      s,
      external({
        webhook: {
          url: 'https://acd.example.com/h',
          credentialId: 'acd-hmac',
          body: { ani: { $from: 'caller.number' } },
        },
      }),
    );
    expect(await codes(s, bound(disabled.id))).toContain(
      'routing_queue_mapping_field_disabled:error',
    );
  });

  it('routing_queue_room_unavailable: a warning for a desk queue with no room server', async () => {
    const s = await setup({ roomConfigured: false });
    const queue = await make(s, managed());
    expect(await codes(s, bound(queue.id))).toContain('routing_queue_room_unavailable:warning');
    const external_ = await make(s, external());
    expect(await codes(s, bound(external_.id))).not.toContain(
      'routing_queue_room_unavailable:warning',
    );
  });

  it('routing_queue_no_operators: a warning when nobody enabled belongs to the queue’s teams', async () => {
    const s = await setup();
    const queue = await make(s, managed({ teamIds: ['billing'] }));
    await s.queues.operators.upsert({
      userId: 'asha',
      displayName: 'A',
      enabled: true,
      teamIds: ['support'],
      languages: [],
      capacity: 1,
    });
    expect(await codes(s, bound(queue.id))).toContain('routing_queue_no_operators:warning');
    await s.queues.operators.upsert({
      userId: 'ravi',
      displayName: 'R',
      enabled: false,
      teamIds: ['billing'],
      languages: [],
      capacity: 1,
    });
    expect(await codes(s, bound(queue.id))).toContain('routing_queue_no_operators:warning');
    await s.queues.operators.upsert({
      userId: 'ravi',
      displayName: 'R',
      enabled: true,
      teamIds: ['billing'],
      languages: [],
      capacity: 1,
    });
    expect(await codes(s, bound(queue.id))).not.toContain('routing_queue_no_operators:warning');
  });

  it('routing_queue_meter_unpriced: a warning naming the meters the router’s cost policy lacks', async () => {
    const s = await setup({
      routerCostPolicy: costPolicy([HUMAN_METER_KEYS.operatorSeconds]) as never,
    });
    const queue = await make(s, managed());
    const point = (await s.call('POST', '/v1/routing/points', { draft: draftInput() })).json();
    const checked = (
      await s.call('POST', `/v1/routing/points/${point.id}/validate`, { draft: bound(queue.id) })
    ).json();
    const issue = checked.issues.find(
      (found: { code: string }) => found.code === 'routing_queue_meter_unpriced',
    );
    expect(issue.severity).toBe('warning');
    expect(issue.message).toContain(HUMAN_METER_KEYS.roomSeconds);
    expect(issue.message).not.toContain(HUMAN_METER_KEYS.operatorSeconds);
  });

  it('routing_queue_language_uncovered: a warning when the queue’s lines lack the point’s default language', async () => {
    const s = await setup();
    const queue = await make(
      s,
      managed({ announcement: { hi: 'आपको एक सहयोगी से जोड़ रहे हैं' } }),
    );
    expect(await codes(s, bound(queue.id))).toContain('routing_queue_language_uncovered:warning');
    const covered = await make(
      s,
      managed({ announcement: { en: 'Connecting you.', hi: 'जोड़ रहे हैं' } }),
    );
    expect(await codes(s, bound(covered.id))).not.toContain(
      'routing_queue_language_uncovered:warning',
    );
    const holdGap = await make(
      s,
      managed({
        hold: {
          steps: [{ kind: 'line', line: { hi: 'रुकिए' } }],
          onTimeout: [{ kind: 'default' }],
        },
      }),
    );
    expect(await codes(s, bound(holdGap.id))).toContain('routing_queue_language_uncovered:warning');
  });

  it('routing_queue_call_limit_short: a warning when the router’s call limit is under 15 minutes', async () => {
    const s = await setup({
      routerCostPolicy: costPolicy(Object.values(HUMAN_METER_KEYS)) as never,
    });
    const queue = await make(s, managed());
    expect(await codes(s, bound(queue.id))).toContain('routing_queue_call_limit_short:warning');
    const roomy = await setup({
      routerCostPolicy: {
        ...costPolicy(Object.values(HUMAN_METER_KEYS)),
        maxCallSeconds: 1800,
      } as never,
    });
    expect(await codes(roomy, bound((await make(roomy, managed())).id))).not.toContain(
      'routing_queue_call_limit_short:warning',
    );
  });

  it('blocks a publish on any error code and publishes through warnings', async () => {
    const s = await setup();
    const bad = await make(
      s,
      external({ webhook: { url: 'http://acd.example.com/h', credentialId: 'acd-hmac' } }),
    );
    const point = (await s.call('POST', '/v1/routing/points', { draft: bound(bad.id) })).json();
    const blocked = await s.call('POST', `/v1/routing/points/${point.id}/releases`, {});
    expect([blocked.statusCode, blocked.json().error.code]).toEqual([
      422,
      'routing_publish_blocked',
    ]);
    expect(blocked.json().blockers.map((b: { code: string }) => b.code)).toContain(
      'routing_queue_endpoint_invalid',
    );
  });
});
