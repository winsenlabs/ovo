import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActiveCallDrain, defaultDrainTimeoutMs } from '../src/worker-drain.ts';

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };

describe('ActiveCallDrain', () => {
  afterEach(() => vi.unstubAllEnvs());

  // ECS SIGKILLs the worker at its 120s stopTimeout: a 240s grace would skip hangup and finalize.
  it('defaults the grace inside each platform stop timeout', () => {
    expect(defaultDrainTimeoutMs('ecs')).toBe(90_000);
    expect(defaultDrainTimeoutMs('process-lifecycle')).toBe(240_000);
    vi.stubEnv('OVO_PROTECTION_MODE', '');
    delete process.env.OVO_PROTECTION_MODE;
    expect(defaultDrainTimeoutMs()).toBe(90_000);
  });

  it('is waiting as soon as it is requested, before wait() starts', () => {
    const drain = new ActiveCallDrain({ log, jobId: () => 'job-1', timeoutMs: 0 });
    expect(drain.waiting).toBe(false);
    drain.request();
    expect(drain.waiting).toBe(true);
  });

  it('does not wait out the grace for a call the loop abandoned before wait() started', async () => {
    const drain = new ActiveCallDrain({ log, jobId: () => 'job-1', timeoutMs: 10_000, pollMs: 5 });
    drain.request();
    drain.abandon();
    const startedAt = Date.now();
    await drain.wait();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(drain.waiting).toBe(false);
  });
});
