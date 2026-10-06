import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createWorkerHealthServer,
  WorkerHealthState,
  type WorkerStatus,
} from '../src/worker-health.ts';

const servers: ReturnType<typeof createWorkerHealthServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve(
  status: WorkerStatus,
  options?: Parameters<typeof createWorkerHealthServer>[2],
) {
  const server = createWorkerHealthServer(0, () => status, options);
  servers.push(server);
  await new Promise((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('worker health (OBS-12)', () => {
  it('keeps /health and /ready unchanged without verbose', async () => {
    const base = await serve({ state: 'active', detail: 'call' });
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      state: 'active',
      detail: 'call',
      liveDialEnabled: process.env.OVO_LIVE_DIAL_ENABLED === 'true',
    });
    expect((await fetch(`${base}/ready`)).status).toBe(503);
    expect((await fetch(`${base}/other`)).status).toBe(404);
  });

  it('serves the live-path state only to the health token', async () => {
    const live = { lastSessionOpenFailure: null, providers: [] };
    const base = await serve(
      { state: 'ready', detail: '' },
      { token: 'secret-token', verbose: () => live },
    );
    expect((await fetch(`${base}/health?verbose=1`)).status).toBe(401);
    const wrong = await fetch(`${base}/health?verbose=1`, {
      headers: { authorization: 'Bearer secret-tokem' },
    });
    expect(wrong.status).toBe(401);
    const ok = await fetch(`${base}/health?verbose=1`, {
      headers: { authorization: 'Bearer secret-token' },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ state: 'ready', live });
  });

  it('refuses verbose health when no token is configured', async () => {
    const base = await serve({ state: 'ready', detail: '' });
    const response = await fetch(`${base}/health?verbose=1`, {
      headers: { authorization: 'Bearer ' },
    });
    expect(response.status).toBe(403);
  });

  it('records the last open failure, handshake percentiles, providers and timeouts', () => {
    const state = new WorkerHealthState();
    for (let ms = 1; ms <= 100; ms++) state.handshake(ms);
    state.handshake(Number.NaN);
    state.sessionOpenFailed({
      stage: 'compose',
      reason: 'error:session-open-failed:compose:stt/acme: connect timeout',
      sessionId: 's-1',
    });
    state.prewarm(
      [
        {
          origin: 'https://stt.example',
          slots: ['stt'],
          ok: false,
          elapsedMs: 3_000,
          error: 'timeout',
        },
      ],
      1_000,
    );
    state.sessionEnded('error:timeout:route_resolve');
    state.sessionEnded('error:session-open-failed:compose:stt/acme: connect timeout');
    state.sessionEnded('caller_hangup');
    state.sessionEnded('caller_hangup');
    state.source('callEvents', () => ({ dropped: 3 }));
    state.source('broken', () => {
      throw new Error('not ready');
    });
    const snapshot = state.snapshot(4_000);
    expect(snapshot.handshakeMs).toEqual({ samples: 100, p50: 50, p95: 95 });
    expect(snapshot.lastSessionOpenFailure).toMatchObject({ stage: 'compose', sessionId: 's-1' });
    expect(snapshot.providers).toEqual([
      {
        origin: 'https://stt.example',
        slots: ['stt'],
        ok: false,
        elapsedMs: 3_000,
        error: 'timeout',
        checkedAt: new Date(1_000).toISOString(),
        ageMs: 3_000,
      },
    ]);
    expect(snapshot.timeouts).toEqual({ route_resolve: 1, 'session_open:stt/acme': 1 });
    expect(snapshot.endReasons).toMatchObject({
      caller_hangup: 2,
      'error:timeout': 1,
      'error:session-open-failed': 1,
    });
    expect(snapshot).toMatchObject({
      callEvents: { dropped: 3 },
      broken: { error: 'not ready' },
    });
  });

  it('reports null percentiles before any handshake', () => {
    expect(new WorkerHealthState().snapshot().handshakeMs).toEqual({
      samples: 0,
      p50: null,
      p95: null,
    });
  });
});
