import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@winsendotai/ovo-contracts';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import {
  buildRoutingSnapshot,
  publishRoutingPoint,
  validateRoutingDraft,
} from '../src/routing-publish.ts';
import {
  DEFAULT_RELEASE,
  exampleReleases,
  POOL_SALES,
  release,
  ROUTER_RELEASE,
  SALES_EN_RELEASE,
  SALES_HI_RELEASE,
  SUPPORT_RELEASE,
} from './routing-fixtures.ts';
import { context, issues, codes, OTHER, BYE } from './routing-publish-harness.ts';

describe('publish validation (A4): the snapshot release bounds', () => {
  it('routing_router_is_only_release: every reference resolves to the router release', async () => {
    const setup = await context({
      pools: 'none',
      patch: (input) => {
        input.defaultTarget = { agentId: 'front-desk', release: { kind: 'latest' } };
        input.nodes[0].engines = [input.nodes[0].engines[0]];
        input.nodes[0].engines[0].rules = [
          { branch: 'done', when: [{ kind: 'dtmf', digits: '1' }] },
        ];
        input.nodes[0].branches = [
          { key: 'done', description: 'Done', target: { kind: 'end', line: BYE } },
        ];
        input.nodes[0].fallback = [{ kind: 'end', line: BYE }];
      },
    });
    const { context: built, draft, routing } = setup;
    const found = (await validateRoutingDraft(built, draft)).issues;
    expect(found.map((issue) => [issue.code, issue.path])).toEqual([
      ['routing_router_is_only_release', ['defaultTarget']],
    ]);
    // Publish blocks with the same issue instead of failing the snapshot parse.
    const point = await routing.points.create(draft);
    expect(await publishRoutingPoint(built, point, 'operator')).toMatchObject({
      kind: 'blocked',
      blockers: [{ code: 'routing_router_is_only_release' }],
    });
  });

  it('routing_limits_exceeded: more distinct releases than a snapshot holds', async () => {
    const poolIds = Array.from(
      { length: 6 },
      (_, p) => `${p + 1}${p + 1}${p + 1}${p + 1}0000-0000-4000-8000-000000000000`,
    );
    const pools = Object.fromEntries(
      poolIds.map((id, p) => [
        id,
        Array.from({ length: 100 }, (_, m): [string, string[]] => [`agent-${p}-${m}`, ['en']]),
      ]),
    );
    const releases = [
      ...exampleReleases(),
      ...Object.values(pools)
        .flat()
        .map(([agentId], n) =>
          release(`${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`, agentId),
        ),
    ];
    const found = await issues({
      pools,
      releases,
      patch: (draft) => {
        draft.nodes[0].engines = [draft.nodes[0].engines[1]];
        draft.nodes[0].branches = poolIds.map((poolId, p) => ({
          key: `pool-${p}`,
          description: `Pool ${p}`,
          target: { kind: 'pool', poolId, language: 'any' },
        }));
      },
    });
    expect(found.map((issue) => [issue.code, issue.path])).toEqual([
      ['routing_limits_exceeded', []],
    ]);
  });
});

describe('the release snapshot (A4)', () => {
  it('pins latest to the newest release and keeps a pinned reference', async () => {
    const newer = '12121212-1212-4121-8121-121212121212';
    const releases = [...exampleReleases(), release(newer, 'sales-hi')];
    const { context: built, draft } = await context({
      releases,
      patch: (input) => {
        input.defaultTarget.release = { kind: 'pinned', releaseId: DEFAULT_RELEASE };
        input.nodes[0].fallback[1] = {
          kind: 'default',
          target: { kind: 'agent', agent: { agentId: 'support', release: { kind: 'latest' } } },
        };
      },
    });
    const { resolution } = await validateRoutingDraft(built, draft);
    const { snapshot, digest } = buildRoutingSnapshot(OTHER, draft, resolution);
    expect(snapshot.defaultTarget.release).toEqual({ kind: 'pinned', releaseId: DEFAULT_RELEASE });
    expect(snapshot.pools[POOL_SALES]!.members.map((m) => m.agent.release)).toEqual([
      { kind: 'pinned', releaseId: DEFAULT_RELEASE },
      { kind: 'pinned', releaseId: newer },
    ]);
    expect(snapshot.nodes[0]!.fallback[1]).toEqual({
      kind: 'default',
      target: {
        kind: 'agent',
        agent: { agentId: 'support', release: { kind: 'pinned', releaseId: SUPPORT_RELEASE } },
      },
    });
    expect(snapshot.releaseIds).toEqual([ROUTER_RELEASE, DEFAULT_RELEASE, SUPPORT_RELEASE, newer]);
    expect(snapshot).toMatchObject({ schemaVersion: 1, routingPointId: OTHER });
    expect(digest).toBe(createHash('sha256').update(canonicalJson(snapshot)).digest('hex'));
    // The draft itself is left as it was.
    expect(draft.nodes[0]!.fallback[1]).toMatchObject({
      target: { agent: { release: { kind: 'latest' } } },
    });
  });

  it('never pins a release of another agent or another workspace', async () => {
    const foreign = { ...release(OTHER, 'support'), workspaceId: 'elsewhere' };
    for (const pinned of [SALES_EN_RELEASE, SALES_HI_RELEASE, OTHER]) {
      const found = await issues({
        releases: [...exampleReleases(), foreign],
        patch: (draft) => (draft.defaultTarget.release = { kind: 'pinned', releaseId: pinned }),
      });
      expect(codes(found)).toContainEqual(['routing_default_target_missing', 'error']);
    }
  });

  it('creates the release only for the draft version it validated', async () => {
    const { context: built, draft, routing } = await context();
    const point = await routing.points.create(draft);
    const created = await publishRoutingPoint(built, point, 'operator');
    expect(created).toMatchObject({
      kind: 'created',
      release: { version: 1, createdBy: 'operator' },
    });
    await routing.points.update(point.id, draft, 1);
    expect(await publishRoutingPoint(built, point, 'operator')).toEqual({ kind: 'conflict' });
  });
});
