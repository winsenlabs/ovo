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
