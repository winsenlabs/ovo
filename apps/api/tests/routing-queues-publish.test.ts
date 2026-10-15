import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { HumanQueueDefinition, HUMAN_METER_KEYS } from '@winsendotai/ovo-contracts';
import { InMemoryHumanQueueService } from '@winsendotai/ovo-plugin-operations/testing';
import {
  costPolicy,
  DEFAULT_RELEASE,
  draftInput,
  exampleReleases,
  FakeRoutingService,
  POOL_SALES,
  POOL_SUPPORT,
  poolInput,
  release,
  ROUTER_RELEASE,
  routingApp,
  WORKSPACE,
} from './routing-fixtures.ts';
import { RoutingPoolDefinition } from '@winsendotai/ovo-contracts';

const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

const KEY = 'support-desk';
const external = (patch: Record<string, unknown> = {}) => ({
  kind: 'external',
  name: `ACD ${Math.random()}`,
  webhook: { url: 'https://acd.example.com/h', credentialId: 'acd-hmac' },
  destination: { allowE164Prefixes: ['+9140'] },
  ...patch,
});
const managed = (patch: Record<string, unknown> = {}) => ({
  kind: 'managed',
  name: `Desk ${Math.random()}`,
  ...patch,
});

interface Options {
  humanQueueEnabled?: boolean;
  humanQueueWebhookEnabled?: boolean;
  roomConfigured?: boolean;
  transferEnabled?: boolean;
  /** Routers with a cost policy that prices the human meters. */
  priced?: boolean;
  routerCostPolicy?: ReturnType<typeof costPolicy>;
}

/** The routing routes over a fake routing service and the in-memory human queue service. */
async function setup(options: Options = {}) {
  const queues = new InMemoryHumanQueueService({ organizationId: WORKSPACE });
  const routing = new FakeRoutingService();
  const releases = [
    ...exampleReleases().filter((item) => item.id !== ROUTER_RELEASE),
    release(ROUTER_RELEASE, 'front-desk'),
  ];
  if (options.routerCostPolicy) {
    const router = releases.find((item) => item.id === ROUTER_RELEASE)!;
    router.config = { ...router.config, costPolicy: options.routerCostPolicy } as never;
  }
  const built = routingApp({
    releases,
    credentials: [
      { id: 'acd-hmac' },
      { id: 'acd-key' },
      { id: 'restricted', permittedAgentIds: ['someone-else'] },
    ],
    operations: { organizationId: WORKSPACE, routing, humanQueues: queues } as never,
    transferEnabled: options.transferEnabled ?? true,
    humanQueueEnabled: options.humanQueueEnabled ?? true,
    humanQueueWebhookEnabled: options.humanQueueWebhookEnabled ?? true,
    roomConfigured: options.roomConfigured ?? true,
  });
  apps.push(built.app);
  await routing.pools.create(
    RoutingPoolDefinition.parse(
      poolInput('Sales', [
        ['sales-en', ['en']],
        ['sales-hi', ['hi']],
      ]),
    ),
    POOL_SALES,
  );
  await routing.pools.create(
    RoutingPoolDefinition.parse(poolInput('Support', [['support', ['en']]])),
    POOL_SUPPORT,
  );
  const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    built.app.inject({ method, url, payload: payload as never });
  return { ...built, routing, queues, call };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const bound = (queueId: string, patch: Record<string, unknown> = {}) => {
  const draft = draftInput();
  draft.humanQueues = [{ key: KEY, queueId, priority: 1 }];
  draft.nodes[0].fallback.splice(1, 0, { kind: 'human', queueId: KEY });
  return Object.assign(draft, patch);
};

async function codes(s: Setup, draft: Record<string, unknown>) {
  const point = (await s.call('POST', '/v1/routing/points', { draft: draftInput() })).json();
  const checked = await s.call('POST', `/v1/routing/points/${point.id}/validate`, { draft });
  expect(checked.statusCode, checked.body).toBe(200);
  return (checked.json().issues as { code: string; severity: string; path: unknown[] }[])
    .filter((issue) => issue.code.startsWith('routing_queue_'))
    .map((issue) => `${issue.code}:${issue.severity}`);
}
const make = (s: Setup, definition: Record<string, unknown>) =>
  s.queues.queues.create(HumanQueueDefinition.parse(definition));
/** A queue stored as a legacy row would be: the destination allow-list the schema now requires, emptied. */
const withEmptyAllowList = (s: Setup) => {
  const parsed = HumanQueueDefinition.parse(external());
  if (parsed.kind !== 'external') throw new Error('kind');
  return s.queues.queues.create({
    ...parsed,
    destination: { ...parsed.destination, allowE164Prefixes: [], allowSipHosts: [] },
  });
};

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

describe('snapshot schema 3', () => {
  it('pins each queue’s definition by value, and later edits do not reach the release', async () => {
    const s = await setup();
    const queue = await make(s, managed({ name: 'Floor', offerSeconds: 20 }));
    const point = (await s.call('POST', '/v1/routing/points', { draft: bound(queue.id) })).json();
    const published = await s.call('POST', `/v1/routing/points/${point.id}/releases`, {});
    expect(published.statusCode, published.body).toBe(201);
    const { snapshot, digest } = published.json();
    expect(snapshot.schemaVersion).toBe(3);
    expect(snapshot.queues[queue.id]).toMatchObject({
      id: queue.id,
      version: 1,
      key: KEY,
      priority: 1,
      definition: { kind: 'managed', name: 'Floor', offerSeconds: 20 },
    });
    await s.queues.queues.update(
      queue.id,
      HumanQueueDefinition.parse(managed({ name: 'Floor', offerSeconds: 60 })),
      1,
    );
    const read = (await s.call('GET', `/v1/routing/releases/${published.json().id}`)).json();
    expect(read.snapshot.queues[queue.id].definition.offerSeconds).toBe(20);
    expect(read.digest).toBe(digest);
    const again = (await s.call('POST', `/v1/routing/points/${point.id}/releases`, {})).json();
    expect(again.snapshot.queues[queue.id].version).toBe(2);
    expect(again.digest).not.toBe(digest);
  });

  it('pins a webhook queue with its allow-list and no secret', async () => {
    const s = await setup();
    const queue = await make(
      s,
      external({
        webhook: {
          url: 'https://acd.example.com/h',
          credentialId: 'acd-hmac',
          auth: { kind: 'bearer', credentialId: 'acd-key' },
        },
      }),
    );
    const point = (await s.call('POST', '/v1/routing/points', { draft: bound(queue.id) })).json();
    const { snapshot } = (
      await s.call('POST', `/v1/routing/points/${point.id}/releases`, {})
    ).json();
    const pinned = snapshot.queues[queue.id].definition;
    expect(pinned.destination.allowE164Prefixes).toEqual(['+9140']);
    expect(pinned.webhook.credentialId).toBe('acd-hmac');
    expect(JSON.stringify(snapshot)).not.toContain('whsec');
  });

  it('keeps schema 1 and 2 for drafts that bind no queue', async () => {
    const s = await setup();
    const plain = (await s.call('POST', '/v1/routing/points', { draft: draftInput() })).json();
    const one = (await s.call('POST', `/v1/routing/points/${plain.id}/releases`, {})).json();
    expect(one.snapshot.schemaVersion).toBe(1);
    expect(one.snapshot.queues).toEqual({});
    const withTransfer = draftInput();
    withTransfer.transfer = {
      targets: [
        {
          key: 'support',
          description: 'Support',
          destination: { kind: 'pool', poolId: POOL_SUPPORT, language: 'any' },
        },
      ],
    };
    const two = (await s.call('POST', '/v1/routing/points', { draft: withTransfer })).json();
    expect(
      (await s.call('POST', `/v1/routing/points/${two.id}/releases`, {})).json().snapshot
        .schemaVersion,
    ).toBe(2);
    void DEFAULT_RELEASE;
  });

  it('binds two keys to two queues', async () => {
    const s = await setup();
    const a = await make(s, managed());
    const b = await make(s, external());
    const draft = bound(a.id);
    draft.humanQueues.push({ key: 'acd', queueId: b.id, priority: 0 });
    draft.nodes[0].fallback.splice(1, 0, { kind: 'human', queueId: 'acd' });
    const point = (await s.call('POST', '/v1/routing/points', { draft })).json();
    const { snapshot } = (
      await s.call('POST', `/v1/routing/points/${point.id}/releases`, {})
    ).json();
    expect(Object.keys(snapshot.queues).sort()).toEqual([a.id, b.id].sort());
  });
});

describe('GET /v1/routing/status', () => {
  it('reports whether human queues are enabled', async () => {
    const on = await setup();
    expect((await on.call('GET', '/v1/routing/status')).json().humanQueueEnabled).toBe(true);
    const off = await setup({ humanQueueEnabled: false });
    expect((await off.call('GET', '/v1/routing/status')).json().humanQueueEnabled).toBe(false);
  });
});
