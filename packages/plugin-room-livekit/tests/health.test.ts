import { describe, expect, it } from 'vitest';
import { CachedHealth } from '../src/health.ts';

const live = new AbortController().signal;

function probe(results: (Error | undefined)[]) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    run: async () => {
      const next = results[Math.min(calls, results.length - 1)];
      calls += 1;
      if (next) throw next;
    },
  };
}
const status = (code: number) =>
  Object.assign(new Error('boom https://secret.example'), { status: code });

describe('CachedHealth', () => {
  it('probes once for concurrent callers and caches ok for five seconds', async () => {
    let now = 1_000;
    const p = probe([undefined]);
    const health = new CachedHealth(p.run, () => now);
    expect(await Promise.all([health.check(live), health.check(live), health.check(live)])).toEqual(
      [{ ok: true }, { ok: true }, { ok: true }],
    );
    now += 4_999;
    await health.check(live);
    expect(p.calls).toBe(1);
    now += 2;
    await health.check(live);
    expect(p.calls).toBe(2);
  });

  it('caches a failure for two seconds, so a down server costs one probe per window', async () => {
    let now = 0;
    const p = probe([status(503), undefined]);
    const health = new CachedHealth(p.run, () => now);
    expect(await health.check(live)).toEqual({ ok: false, reason: 'http_503' });
    now += 1_999;
    expect(await health.check(live)).toEqual({ ok: false, reason: 'http_503' });
    expect(p.calls).toBe(1);
    now += 2;
    expect(await health.check(live)).toEqual({ ok: true });
  });

  it.each([
    [status(401), 'unauthorized'],
    [status(403), 'unauthorized'],
    [new Error('connect ECONNREFUSED 10.0.0.9:7880'), 'unreachable'],
  ])('reports a short code, never the server message: %#', async (error, reason) => {
    const health = new CachedHealth(probe([error]).run);
    const result = await health.check(live);
    expect(result).toEqual({ ok: false, reason });
    expect(JSON.stringify(result)).not.toMatch(/secret|10\.0\.0/);
  });

  it('gives up on a probe that never answers', async () => {
    const health = new CachedHealth(() => new Promise<void>(() => undefined));
    const started = Date.now();
    expect(await health.check(live)).toEqual({ ok: false, reason: 'timeout' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
  }, 10_000);

  it('a caller that aborts stops waiting without cancelling the probe others share', async () => {
    let release!: () => void;
    const p = { calls: 0 };
    const health = new CachedHealth(() => {
      p.calls += 1;
      return new Promise<void>((resolve) => (release = resolve));
    });
    const controller = new AbortController();
    const patient = health.check(live);
    const impatient = health.check(controller.signal);
    controller.abort();
    expect(await impatient).toEqual({ ok: false, reason: 'aborted' });
    release();
    expect(await patient).toEqual({ ok: true });
    expect(p.calls).toBe(1);
    expect(await health.check(AbortSignal.abort())).toEqual({ ok: true });
  });
});
