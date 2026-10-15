import { describe, expect, it } from 'vitest';
import { HumanBreaker, HumanShared } from '../src/human-breaker.ts';

describe('the per-queue circuit breaker (human queue design 7.4)', () => {
  it('opens after five failures in a minute, for thirty seconds', () => {
    let now = 0;
    const breaker = new HumanBreaker(() => now);
    for (let i = 0; i < 4; i += 1) breaker.failure();
    expect(breaker.open).toBe(false);
    breaker.failure();
    expect(breaker.open).toBe(true);
    now = 29_999;
    expect(breaker.open).toBe(true);
    now = 30_000;
    expect(breaker.open).toBe(false);
  });

  it('forgets failures older than a minute, and a success clears the count', () => {
    let now = 0;
    const breaker = new HumanBreaker(() => now);
    for (let i = 0; i < 4; i += 1) breaker.failure();
    now = 61_000;
    breaker.failure();
    expect(breaker.open).toBe(false);
    for (let i = 0; i < 3; i += 1) breaker.failure();
    breaker.success();
    breaker.failure();
    expect(breaker.open).toBe(false);
  });

  it('is shared per queue across calls, and caches the room health for thirty seconds', async () => {
    let now = 0;
    const shared = new HumanShared(() => now);
    expect(shared.breaker('a')).toBe(shared.breaker('a'));
    expect(shared.breaker('a')).not.toBe(shared.breaker('b'));
    let probes = 0;
    let ok = true;
    const rooms = {
      health: async () => (
        ++probes,
        ok ? ({ ok: true } as const) : ({ ok: false, reason: 'down' } as const)
      ),
    };
    expect(await shared.roomHealthy(rooms)).toBe(true);
    ok = false;
    now = 29_000;
    expect(await shared.roomHealthy(rooms)).toBe(true);
    now = 31_000;
    expect(await shared.roomHealthy(rooms)).toBe(false);
    expect(probes).toBe(2);
    const throwing = { health: async () => Promise.reject(new Error('refused')) };
    now = 100_000;
    expect(await shared.roomHealthy(throwing)).toBe(false);
  });
});
