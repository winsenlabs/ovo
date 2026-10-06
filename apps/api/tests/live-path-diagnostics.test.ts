import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readWorkerLiveState } from '../src/inbound-readiness.ts';
import { liveDiagnostics, type LivePathInfrastructure } from '../src/live-readiness.ts';
import { registerReadinessRoutes } from '../src/routes/readiness.ts';

const NOW = Date.parse('2026-10-06T10:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: 'org',
    generatedAt: ago(0),
    filter: { releaseId: null },
    installation: { enabled: true, status: 'ready', reasons: [], admissionSafety: '' },
    workers: { ready: 1, reserved: 0, active: 1, total: 2 },
    queue: { depth: 0, eligibleDepth: 0, oldestAgeMs: null, reconciliationDepth: 0 },
    ...overrides,
  };
}

function infrastructure(input: {
  snapshot?: () => Promise<unknown>;
  inbound?: unknown;
  workers?: unknown[];
}): LivePathInfrastructure {
  return {
    organizationId: 'org',
    snapshot: (input.snapshot ?? (async () => snapshot())) as never,
    inboundReadiness: async () => (input.inbound ?? null) as never,
    workerLiveState: async () => (input.workers ?? []) as never,
  };
}

const healthyWorker = {
  workerId: 'w1',
  state: 'ready_idle',
  observedAt: ago(1_000),
  live: {
    lastSessionOpenFailure: null,
    handshakeMs: { samples: 3, p50: 40, p95: 90 },
    providers: [
      {
        origin: 'https://stt.example',
        slots: ['stt'],
        ok: true,
        elapsedMs: 80,
        checkedAt: ago(60_000),
      },
    ],
    timeouts: {},
    callEvents: { dropped: 0 },
  },
};

describe('live-path diagnostics (OBS-12)', () => {
  it('is ready when every stage is healthy', async () => {
    const result = await liveDiagnostics(infrastructure({ workers: [healthyWorker] }), 'org', NOW);
    expect(result).toMatchObject({
      ready: true,
      blockers: [],
      database: { ok: true },
      providers: [{ origin: 'https://stt.example', ok: true, workerId: 'w1' }],
      workerHealth: [{ workerId: 'w1', handshakeMs: { p50: 40, p95: 90 } }],
    });
  });

  it('names each blocking stage', async () => {
    const worker = {
      ...healthyWorker,
      live: {
        ...healthyWorker.live,
        lastSessionOpenFailure: {
          stage: 'compose',
          reason: 'error:session-open-failed:compose:stt/acme: connect timeout',
          at: ago(30_000),
        },
        providers: [
          {
            origin: 'https://tts.example',
            slots: ['tts'],
            ok: false,
            error: 'ECONNREFUSED',
            checkedAt: ago(5_000),
          },
          { origin: 'https://old.example', ok: false, error: 'old', checkedAt: ago(3_600_000) },
        ],
      },
    };
    const result = await liveDiagnostics(
      infrastructure({
        snapshot: async () =>
          snapshot({
            installation: { enabled: false, status: 'disabled', reasons: ['live dial disabled'] },
            workers: { ready: 0, reserved: 0, active: 1 },
            queue: { oldestAgeMs: 120_000 },
          }),
        inbound: {
          admissionEnabled: true,
          ready: false,
          stale: false,
          reasons: ['no protected slot'],
        },
        workers: [worker],
      }),
      'org',
      NOW,
    );
    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual([
      'installation: live dial disabled',
      'workers: no idle worker can take a call',
      'queue: oldest job waited 120 s',
      'inbound: no protected slot',
      'provider tts: ECONNREFUSED',
      'session open (compose) on w1: error:session-open-failed:compose:stt/acme: connect timeout',
    ]);
  });

  it('reports an unreachable database and a missing service', async () => {
    const down = await liveDiagnostics(
      infrastructure({
        snapshot: async () => {
          throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
        },
      }),
      'org',
      NOW,
    );
    expect(down).toMatchObject({
      ready: false,
      database: { ok: false, error: 'connect ECONNREFUSED 127.0.0.1:5432' },
    });
    expect(down.blockers[0]).toBe('database: connect ECONNREFUSED 127.0.0.1:5432');
    expect(await liveDiagnostics(undefined, 'org', NOW)).toEqual({
      ready: false,
      blockers: ['infrastructure: readiness service is not configured'],
    });
  });
});

describe('GET /v1/diagnostics/live-path', () => {
  const apps: { close(): Promise<unknown> }[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  function build(role: string, infra?: LivePathInfrastructure) {
    const app = Fastify({ logger: false });
    apps.push(app);
    app.addHook('onRequest', async (request) => {
      (request as unknown as { principal: unknown }).principal = {
        workspaceId: 'org',
        identityId: 'u1',
        role,
      };
    });
    registerReadinessRoutes({
      app,
      store: {} as never,
      options: {} as never,
      catalog: [],
      services: {} as never,
      infrastructure: infra,
    });
    return app;
  }

  it('answers 200 when ready and 503 with blockers when not, to admins only', async () => {
    const ready = await build('admin', infrastructure({})).inject('/v1/diagnostics/live-path');
    expect(ready.statusCode).toBe(200);
    expect(ready.json().ready).toBe(true);
    const blocked = await build('admin').inject('/v1/diagnostics/live-path');
    expect(blocked.statusCode).toBe(503);
    expect(blocked.json().blockers).toEqual([
      'infrastructure: readiness service is not configured',
    ]);
    const viewer = await build('viewer', infrastructure({})).inject('/v1/diagnostics/live-path');
    expect(viewer.statusCode).toBe(403);
  });
});

describe('readWorkerLiveState', () => {
  it('reads each fresh worker and the live state its report carried', async () => {
    const query = vi.fn(async (_sql: string, _values: unknown[]) => ({
      rows: [
        { worker_id: 'w1', state: 'active', observed_at: new Date(NOW), live: { timeouts: {} } },
        { worker_id: 'w2', state: 'ready_idle', observed_at: new Date(NOW), live: null },
      ],
    }));
    expect(await readWorkerLiveState({ query } as never, 15_000)).toEqual([
      { workerId: 'w1', state: 'active', observedAt: ago(0), live: { timeouts: {} } },
      { workerId: 'w2', state: 'ready_idle', observedAt: ago(0), live: null },
    ]);
    expect(query.mock.calls[0]![1]).toEqual([15_000, 50]);
  });
});
