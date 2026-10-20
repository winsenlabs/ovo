import { describe, expect, it } from 'vitest';
import { RoutingPointSummary, RoutingReleaseSummary, RoutingStatus } from '../src/index.ts';
import { POINT_ID, SALES_EN_RELEASE } from './routing-fixture.ts';

const status = {
  enabled: true,
  externalEnabled: false,
  transferEnabled: false,
  humanQueueEnabled: false,
  simulate: { enabled: true, liveLlm: false, liveExternal: false },
  evalRuns: true,
  outcomesAvailable: false,
};
const stub = {
  id: SALES_EN_RELEASE,
  version: 2,
  digest: 'a'.repeat(64),
  draftVersion: 3,
  createdAt: '2026-10-20T10:00:00.000Z',
};

describe('RoutingStatus', () => {
  it('accepts the dark and the lit status', () => {
    expect(RoutingStatus.safeParse(status).success).toBe(true);
    const dark = {
      ...status,
      enabled: false,
      simulate: { enabled: false, liveLlm: false, liveExternal: false },
      evalRuns: false,
    };
    expect(RoutingStatus.safeParse(dark).success).toBe(true);
  });

  it('rejects a status without the R4 fields', () => {
    const { simulate: _s, ...old } = status;
    expect(RoutingStatus.safeParse(old).success).toBe(false);
    expect(RoutingStatus.safeParse({ ...status, evalRuns: 'yes' }).success).toBe(false);
  });
});

describe('RoutingPointSummary', () => {
  const summary = {
    nodes: 3,
    pools: 2,
    languages: ['en', 'hi'],
    humanQueues: 1,
    latestRelease: stub,
    published: true,
    numbers: 4,
  };

  it('accepts a published point and one never published', () => {
    expect(RoutingPointSummary.safeParse(summary).success).toBe(true);
    expect(
      RoutingPointSummary.safeParse({
        ...summary,
        latestRelease: null,
        published: false,
        numbers: 0,
      }).success,
    ).toBe(true);
  });

  it('rejects negative counts, bad languages and a short digest', () => {
    expect(RoutingPointSummary.safeParse({ ...summary, nodes: -1 }).success).toBe(false);
    expect(RoutingPointSummary.safeParse({ ...summary, languages: ['english'] }).success).toBe(
      false,
    );
    expect(
      RoutingPointSummary.safeParse({ ...summary, latestRelease: { ...stub, digest: 'abc' } })
        .success,
    ).toBe(false);
  });
});

describe('RoutingReleaseSummary', () => {
  const summary = {
    ...stub,
    routingPointId: POINT_ID,
    createdBy: 'user:1',
    counts: { nodes: 2, pools: 1, members: 3, agents: 5, humanQueues: 0 },
    numbers: 0,
  };

  it('accepts a release summary and carries no snapshot', () => {
    const parsed = RoutingReleaseSummary.parse({ ...summary, snapshot: {} });
    expect(parsed).not.toHaveProperty('snapshot');
  });

  it('rejects a missing count', () => {
    const { counts, ...rest } = summary;
    expect(RoutingReleaseSummary.safeParse(rest).success).toBe(false);
    expect(
      RoutingReleaseSummary.safeParse({ ...summary, counts: { ...counts, members: undefined } })
        .success,
    ).toBe(false);
  });
});
