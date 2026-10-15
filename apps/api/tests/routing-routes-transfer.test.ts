import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { RoutingPoolDefinition } from '@winsendotai/ovo-contracts';
import {
  DEFAULT_RELEASE,
  draftInput,
  exampleReleases,
  POOL_SALES,
  POOL_SUPPORT,
  poolInput,
  release,
  routingApp,
} from './routing-fixtures.ts';
import { clipInput } from './routing-audio-fixtures.ts';

const POOL_BILLING = '33333333-3333-4333-8333-333333333333';
const CLIP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

async function setup(options: Parameters<typeof routingApp>[0] = {}) {
  const built = routingApp({
    releases: [
      ...exampleReleases().filter((item) => item.id !== DEFAULT_RELEASE),
      release(DEFAULT_RELEASE, 'sales-en', {
        config: { handoff: { agents: { llmTool: true, nodes: {} } } },
      }),
    ],
    ...options,
  });
  apps.push(built.app);
  const definition = (name: string, members: [string, string[]][]) =>
    RoutingPoolDefinition.parse(poolInput(name, members));
  await built.routing.pools.create(
    definition('Sales', [
      ['sales-en', ['en']],
      ['sales-hi', ['hi']],
    ]),
    POOL_SALES,
  );
  await built.routing.pools.create(definition('Support', [['support', ['en']]]), POOL_SUPPORT);
  await built.routing.pools.create(definition('Billing', [['support', ['en']]]), POOL_BILLING);
  const call = (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) => built.app.inject({ method, url, payload: payload as never, headers });
  return { ...built, call };
}

/** The worked example plus a catalogue whose only use of the billing pool is a transfer. */
function transferDraft() {
  const draft = draftInput();
  draft.transfer = {
    targets: [
      {
        key: 'billing',
        description: 'Payments and refunds',
        destination: { kind: 'pool', poolId: POOL_BILLING, language: 'any' },
      },
    ],
    hold: {
      steps: [{ kind: 'clip', assetId: CLIP }],
      onTimeout: [{ kind: 'default' }, { kind: 'end', line: { en: 'Goodbye.' } }],
    },
  };
  return draft;
}

describe('pools in use (R1 audit 5)', () => {
  it('reads usedBy from the service, so a transfer destination counts', async () => {
    const { call, routing } = await setup();
    const point = (await call('POST', '/v1/routing/points', { draft: transferDraft() })).json();
    const usedBy = vi.spyOn(routing.pools, 'usedBy');
    const read = await call('GET', `/v1/routing/pools/${POOL_BILLING}`);
    expect(read.json().usedBy).toEqual([point.id]);
    expect(usedBy).toHaveBeenCalledWith(POOL_BILLING);
    const refused = await call('DELETE', `/v1/routing/pools/${POOL_BILLING}`, undefined, {
      'if-match': '"1"',
    });
    expect([refused.statusCode, refused.json().usedBy]).toEqual([409, [point.id]]);
  });

  it('reports a deleted pool as routing_pool_deleted, not missing', async () => {
    const { call, routing } = await setup();
    const point = (await call('POST', '/v1/routing/points', { draft: draftInput() })).json();
    expect(
      (await call('DELETE', `/v1/routing/pools/${POOL_BILLING}`, undefined, { 'if-match': '"1"' }))
        .statusCode,
    ).toBe(204);
    const tree = draftInput();
    tree.nodes[0].branches[1].target.poolId = POOL_BILLING;
    const checked = await call('POST', `/v1/routing/points/${point.id}/validate`, { draft: tree });
    expect(checked.json().issues.map((issue: { code: string }) => issue.code)).toEqual([
      'routing_pool_deleted',
    ]);
    await routing.audio.create(clipInput('Music'), CLIP);
    const transfer = await call('POST', `/v1/routing/points/${point.id}/validate`, {
      draft: transferDraft(),
    });
    expect(transfer.json().issues.map((issue: { code: string }) => issue.code)).toEqual([
      'routing_transfer_disabled',
      'routing_transfer_pool_deleted',
    ]);
  });
});

describe('publishing a transfer catalogue (Wave 16)', () => {
  it('publishes schema version 2 with the clip digest pinned, warning while transfers are off', async () => {
    const { call, routing } = await setup();
    const clip = await routing.audio.create(clipInput('Music'), CLIP);
    const point = (await call('POST', '/v1/routing/points', { draft: transferDraft() })).json();
    const published = await call('POST', `/v1/routing/points/${point.id}/releases`, {});
    expect(published.statusCode, published.body).toBe(201);
    const body = published.json();
    expect(body.warnings.map((issue: { code: string }) => issue.code)).toEqual([
      'routing_transfer_disabled',
    ]);
    expect(body.snapshot.schemaVersion).toBe(2);
    expect(body.snapshot.transfer.hold.steps[0]).toEqual({
      kind: 'clip',
      assetId: CLIP,
      sha256: clip !== 'name_taken' && clip.sha256,
    });
    expect(Object.keys(body.snapshot.pools)).toContain(POOL_BILLING);
    // The clip a published draft names stays in use.
    expect((await call('DELETE', `/v1/routing/audio/${CLIP}`)).statusCode).toBe(409);
  });

  it('blocks a release that would pin a deleted clip', async () => {
    const { call, routing } = await setup({ transferEnabled: true });
    await routing.audio.create(clipInput('Music'), CLIP);
    expect((await call('DELETE', `/v1/routing/audio/${CLIP}`)).statusCode).toBe(204);
    const point = (await call('POST', '/v1/routing/points', { draft: draftInput() })).json();
    const checked = await call('POST', `/v1/routing/points/${point.id}/validate`, {
      draft: transferDraft(),
    });
    expect(checked.json().issues).toEqual([
      expect.objectContaining({
        code: 'routing_transfer_audio_deleted',
        severity: 'error',
        path: ['transfer', 'hold', 'steps', 0, 'assetId'],
      }),
    ]);
  });
});
