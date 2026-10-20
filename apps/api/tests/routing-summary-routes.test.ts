import { describe, expect, it } from 'vitest';
import {
  PublishPreview,
  RoutingPointSummary,
  RoutingReleaseSummary,
} from '@winsendotai/ovo-contracts';
import { SALES_HI_RELEASE, draftInput } from './routing-fixtures.ts';
import { publishPoint, r4Setup } from './routing-sim-fixtures.ts';

const viewer = { 'x-role': 'viewer' };

const number = (phoneNumber: string, routingReleaseId: string, pointId: string) => ({
  phoneNumber,
  routingReleaseId,
  pointId,
});

describe('GET /v1/routing/points?include=summary (R4)', () => {
  it('adds a summary to each point: sizes, latest release, published, numbers', async () => {
    const numbers: ReturnType<typeof number>[] = [];
    const { call } = await r4Setup({ numbers });
    const edited = await publishPoint(call);
    const published = await publishPoint(call);
    const draftOnly = (await call('POST', '/v1/routing/points', { draft: draftInput() })).json();
    // Editing the first point after its release leaves it with unpublished changes.
    await call(
      'PUT',
      `/v1/routing/points/${edited.point.id}`,
      { draft: { ...draftInput(), name: 'Main line v2' } },
      { 'if-match': '"1"' },
    );
    numbers.push(
      number('+14155550100', edited.release.id, edited.point.id),
      number('+14155550101', edited.release.id, edited.point.id),
      number('+14155550102', published.release.id, published.point.id),
    );
    const plain = await call('GET', '/v1/routing/points', undefined, viewer);
    expect(plain.json().items[0]).not.toHaveProperty('summary');

    const listed = await call('GET', '/v1/routing/points?include=summary', undefined, viewer);
    expect(listed.statusCode, listed.body).toBe(200);
    const summaryOf = (id: string) =>
      RoutingPointSummary.parse(
        listed.json().items.find((item: { id: string }) => item.id === id).summary,
      );
    expect(summaryOf(edited.point.id)).toMatchObject({
      nodes: 1,
      pools: 2,
      languages: ['en', 'hi'],
      humanQueues: 0,
      latestRelease: {
        id: edited.release.id,
        version: 1,
        digest: edited.release.digest,
        draftVersion: 1,
      },
      published: false,
      numbers: 2,
    });
    expect(summaryOf(published.point.id)).toMatchObject({ published: true, numbers: 1 });
    expect(summaryOf(draftOnly.id)).toMatchObject({
      latestRelease: null,
      published: false,
      numbers: 0,
    });
  });

  it('keeps paging and rejects an unknown include or query key', async () => {
    const { call } = await r4Setup();
    for (let i = 0; i < 3; i += 1)
      await call('POST', '/v1/routing/points', { draft: draftInput() });
    const page = await call('GET', '/v1/routing/points?include=summary&limit=2', undefined, viewer);
    expect(page.json().items).toHaveLength(2);
    expect(page.json().nextCursor).toBe(page.json().items[1].id);
    const next = await call(
      'GET',
      `/v1/routing/points?include=summary&limit=2&cursor=${page.json().nextCursor}`,
      undefined,
      viewer,
    );
    expect(next.json().items).toHaveLength(1);
    expect(next.json().items[0]).toHaveProperty('summary');
    expect(
      (await call('GET', '/v1/routing/points?include=everything', undefined, viewer)).statusCode,
    ).toBe(400);
    expect((await call('GET', '/v1/routing/points?bogus=1', undefined, viewer)).statusCode).toBe(
      400,
    );
  });
});

describe('GET /v1/routing/points/:id/releases?view=summary (R4)', () => {
  it('lists releases without snapshots, with counts and the numbers pinned to each', async () => {
    const numbers: ReturnType<typeof number>[] = [];
    const { call } = await r4Setup({ numbers });
    const { point, release } = await publishPoint(call);
    const second = (await call('POST', `/v1/routing/points/${point.id}/releases`, {})).json();
    numbers.push(number('+14155550100', second.id, point.id));
    const listed = await call(
      'GET',
      `/v1/routing/points/${point.id}/releases?view=summary`,
      undefined,
      viewer,
    );
    expect(listed.statusCode, listed.body).toBe(200);
    const items = listed.json().items;
    expect(items.map((item: { version: number }) => item.version)).toEqual([2, 1]);
    for (const item of items) {
      expect(RoutingReleaseSummary.safeParse(item).success).toBe(true);
      expect(item).not.toHaveProperty('snapshot');
    }
    expect(items[0]).toMatchObject({ id: second.id, numbers: 1 });
    expect(items[1]).toMatchObject({
      id: release.id,
      routingPointId: point.id,
      counts: { nodes: 1, pools: 2, members: 3, agents: 4, humanQueues: 0 },
      numbers: 0,
    });
    const full = await call('GET', `/v1/routing/points/${point.id}/releases`, undefined, viewer);
    expect(full.json().items[0]).toHaveProperty('snapshot');
    const missing = `/v1/routing/points/${SALES_HI_RELEASE}/releases?view=summary`;
    expect((await call('GET', missing, undefined, viewer)).statusCode).toBe(404);
  });
});

describe('POST /v1/routing/points/:id/preview-publish (R4)', () => {
  it('previews a first publish: version 1, all additions, the digest publish will store', async () => {
    const { call } = await r4Setup();
    const point = (await call('POST', '/v1/routing/points', { draft: draftInput() })).json();
    const preview = await call('POST', `/v1/routing/points/${point.id}/preview-publish`, {});
    expect(preview.statusCode, preview.body).toBe(200);
    const body = PublishPreview.parse(preview.json());
    expect(body).toMatchObject({
      canPublish: true,
      blockers: [],
      nextVersion: 1,
      previous: null,
      unchanged: false,
    });
    expect(body.changes.map((change) => `${change.area}:${change.op}`)).toEqual([
      'point:added',
      'node:added',
      'pool:added',
      'pool:added',
    ]);
    // The refs the release would pin: router, default, and every pool member.
    expect(body.pins.map((pin) => [pin.agentId, pin.was])).toEqual([
      ['front-desk', 'latest'],
      ['sales-en', 'latest'],
      ['sales-en', 'latest'],
      ['sales-hi', 'latest'],
      ['support', 'latest'],
    ]);

    const published = (await call('POST', `/v1/routing/points/${point.id}/releases`, {})).json();
    expect(published.digest).toBe(body.digest);
  });

  it('shows what changed since the latest release, and flags no change', async () => {
    const { call } = await r4Setup();
    const { point, release } = await publishPoint(call);
    const same = PublishPreview.parse(
      (await call('POST', `/v1/routing/points/${point.id}/preview-publish`, {})).json(),
    );
    expect(same).toMatchObject({
      unchanged: true,
      changes: [],
      nextVersion: 2,
      previous: { id: release.id, version: 1, digest: release.digest },
      digest: release.digest,
    });

    const edited = draftInput();
    edited.name = 'Main line v2';
    edited.nodes[0].branches[0].description = 'Wants to purchase';
    const carried = PublishPreview.parse(
      (
        await call('POST', `/v1/routing/points/${point.id}/preview-publish`, { draft: edited })
      ).json(),
    );
    expect(carried.unchanged).toBe(false);
    expect(carried.changes.map((change) => change.summary)).toEqual([
      'Name changed from "Main line" to "Main line v2"',
      'Branch sales of node intent changed (description)',
    ]);
    // Previewing writes nothing: the stored draft is as it was and no release was made.
    expect(
      (await call('GET', `/v1/routing/points/${point.id}`, undefined, viewer)).json().draft.name,
    ).toBe('Main line');
    expect(
      (await call('GET', `/v1/routing/points/${point.id}/releases`, undefined, viewer)).json()
        .items,
    ).toHaveLength(1);
    // What the preview said is what publishing that draft then stores.
    await call('PUT', `/v1/routing/points/${point.id}`, { draft: edited }, { 'if-match': '"1"' });
    const after = (await call('POST', `/v1/routing/points/${point.id}/releases`, {})).json();
    expect(after.digest).toBe(carried.digest);
  });

  it('lists blockers with no digest and still shows the structural changes', async () => {
    const { call } = await r4Setup();
    const point = (await call('POST', '/v1/routing/points', { draft: draftInput() })).json();
    const broken = draftInput();
    broken.router = { agentId: 'nobody', release: { kind: 'latest' } };
    const preview = PublishPreview.parse(
      (
        await call('POST', `/v1/routing/points/${point.id}/preview-publish`, { draft: broken })
      ).json(),
    );
    expect(preview).toMatchObject({ canPublish: false, digest: null, unchanged: false });
    expect(preview.blockers.map((issue) => issue.code)).toEqual(['routing_router_missing']);
    expect(preview.changes.length).toBeGreaterThan(0);
  });

  it('refuses an invalid carried draft, an unknown point, a viewer and extra fields', async () => {
    const { call } = await r4Setup();
    const point = (await call('POST', '/v1/routing/points', { draft: draftInput() })).json();
    const url = `/v1/routing/points/${point.id}/preview-publish`;
    const invalid = await call('POST', url, { draft: { name: 'x' } });
    expect([invalid.statusCode, invalid.json().error.code]).toEqual([422, 'routing_draft_invalid']);
    const missing = await call(
      'POST',
      `/v1/routing/points/${SALES_HI_RELEASE}/preview-publish`,
      {},
    );
    expect([missing.statusCode, missing.json().error.code]).toEqual([
      404,
      'routing_point_not_found',
    ]);
    expect((await call('POST', url, {}, viewer)).statusCode).toBe(403);
    expect((await call('POST', url, { surprise: true })).statusCode).toBe(400);
  });
});
