import { describe, expect, it } from 'vitest';
import { INBOUND, NUMBER, STATUS } from './fake-stack.ts';

type Result = { id: string; status: 'pass' | 'fail' | 'warn' | 'skip'; message: string };
type Snapshot = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const { evaluateLive } = (await import('../live-checks.mjs' as string)) as {
  evaluateLive(snapshot: Snapshot): Result[];
};
const { collectLiveSnapshot } = (await import('../live-collect.mjs' as string)) as {
  collectLiveSnapshot(input: Snapshot): Promise<Snapshot>;
};

const ROUTING = 'rr-1';
const routing = (version = 3) => ({
  id: ROUTING,
  version,
  snapshot: {
    router: { agentId: 'front-desk', release: { kind: 'pinned', releaseId: 'rel-router' } },
    defaultTarget: { agentId: 'sales-en', release: { kind: 'pinned', releaseId: 'rel-default' } },
    releaseIds: ['rel-router', 'rel-default', 'rel-en', 'rel-hi'],
  },
});
const ready = { liveReady: true, liveBlockers: [] };

/** A routed number bound to routing release `rr-1` (Wave 15): `releaseId` is null. */
function routedSnapshot(): Snapshot {
  return {
    routes: [
      {
        phoneNumber: NUMBER,
        releaseId: null,
        routingReleaseId: ROUTING,
        enabled: true,
        carrierBindingId: 'bind-1',
      },
    ],
    routingReleases: {
      [ROUTING]: {
        version: 3,
        router: 'rel-router',
        defaultTarget: 'rel-default',
        members: ['rel-en', 'rel-hi'],
      },
    },
    releases: {
      'rel-router': { agentId: 'front-desk', ...ready },
      'rel-default': { agentId: 'sales-en', ...ready },
    },
  };
}
const releasesCheck = (snapshot: Snapshot) =>
  evaluateLive({ apiEnv: {}, serviceEnv: {}, mode: 'pre-switch', ...snapshot }).find(
    (result) => result.id === 'releases-live-ready',
  )!;

describe('live readiness of routed numbers (R1 audit gap 1)', () => {
  it('passes when the router and the default agent are live-ready, listing the members', () => {
    const result = releasesCheck(routedSnapshot());
    expect(result.status).toBe('pass');
    expect(result.message).toContain(
      `${NUMBER} → routing release 3 (2 member release(s) not checked)`,
    );
  });

  it('fails naming the router or default agent that is not live-ready', () => {
    const snapshot = routedSnapshot();
    snapshot.releases['rel-router'] = { liveReady: false, liveBlockers: ['No STT binding'] };
    snapshot.releases['rel-default'] = { error: 'HTTP 404' };
    const result = releasesCheck(snapshot);
    expect(result.status).toBe('fail');
    expect(result.message).toContain(
      `${NUMBER} → routing release 3 router rel-router: No STT binding`,
    );
    expect(result.message).toContain('default agent rel-default: HTTP 404');
    expect(result.message).not.toContain('release null');
  });

  it('fails when the routing release cannot be read', () => {
    const snapshot = routedSnapshot();
    snapshot.routingReleases[ROUTING] = { error: 'HTTP 404 routing_disabled' };
    expect(releasesCheck(snapshot).message).toContain(
      `${NUMBER} → routing release ${ROUTING}: HTTP 404 routing_disabled`,
    );
    delete snapshot.routingReleases;
    expect(releasesCheck(snapshot).status).toBe('fail');
  });

  it('collects the routing release and its router and default readiness, never /v1/releases/null', async () => {
    const asked: string[] = [];
    const replies: Record<string, unknown> = {
      '/v1/operations/inbound/capacity': { readyProtected: 1 },
      '/v1/operations/inbound/routes?limit=100': {
        items: [
          ...routedSnapshot().routes,
          {
            phoneNumber: '+14155550199',
            releaseId: 'rel-direct',
            enabled: true,
            carrierBindingId: 'bind-1',
          },
        ],
      },
      [`/v1/routing/releases/${ROUTING}`]: routing(),
      '/v1/releases/rel-router': { agentId: 'front-desk' },
      '/v1/releases/rel-default': { agentId: 'sales-en' },
      '/v1/releases/rel-direct': { agentId: 'direct' },
      '/v1/agents/front-desk/readiness': ready,
      '/v1/agents/sales-en/readiness': { liveReady: false, liveBlockers: ['No TTS binding'] },
      '/v1/agents/direct/readiness': ready,
      '/v1/provider-bindings/bind-1/carrier-urls': {
        items: [
          { purpose: 'inbound', url: INBOUND },
          { purpose: 'status', url: STATUS },
        ],
      },
    };
    const session = {
      async get(path: string) {
        asked.push(path);
        if (!(path in replies)) throw new Error(`HTTP 404 ${path}`);
        return replies[path];
      },
    };
    const probe = {
      json: async () => ({ body: {} }),
      http: async () => ({ status: 200 }),
      upgrade: async () => ({ status: 403 }),
    };
    const snapshot = await collectLiveSnapshot({
      session,
      probe,
      mode: 'pre-switch',
      apiEnv: { OVO_MEDIA_PUBLIC_BASE_URL: 'https://voice.ovo.test' },
      serviceEnv: {},
      endpoints: { workers: {}, dispatcher: 'http://dispatcher' },
      ops: {},
    });
    expect(asked.some((path) => path.includes('null'))).toBe(false);
    expect(snapshot.routingReleases[ROUTING]).toEqual({
      version: 3,
      router: 'rel-router',
      defaultTarget: 'rel-default',
      members: ['rel-en', 'rel-hi'],
    });
    expect(Object.keys(snapshot.releases).sort()).toEqual([
      'rel-default',
      'rel-direct',
      'rel-router',
    ]);
    expect(releasesCheck(snapshot).message).toContain(
      `${NUMBER} → routing release 3 default agent rel-default: No TTS binding`,
    );
  });
});
