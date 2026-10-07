import { Cap } from '@winsendotai/ovo-contracts';
import type { Composition } from '@winsendotai/ovo-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

const prerender = vi.hoisted(() => vi.fn((composition: Composition) => composition));

vi.mock('@winsendotai/ovo-distribution', () => ({
  loadDistribution: vi.fn(async () => ({ catalog: [], defaults: {} })),
}));
vi.mock('../src/worker-environment.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/worker-environment.ts')>()),
  durableAdapterPlugins: () => ({ definitions: [], rows: [] }),
}));
vi.mock('../src/speech-cache-dial-disabled.ts', () => ({ withDialDisabledPrerender: prerender }));

const { openWorkerProcess } = await import('../src/worker-process.ts');

afterEach(() => vi.unstubAllEnvs());

describe('openWorkerProcess with live dialing off', () => {
  // P11, 2026-10-07: the dial-disabled branch returned before startPrerender.
  it('hands its composition, with a net, to the pre-render starter', async () => {
    vi.stubEnv('OVO_LIVE_DIAL_ENABLED', 'false');
    const opened = await openWorkerProcess();
    expect(opened.kind).toBe('dial-disabled');
    expect(prerender).toHaveBeenCalledOnce();
    const [composition, distribution] = prerender.mock.calls[0]! as unknown as [
      Composition,
      unknown,
    ];
    expect(composition.ctx.get(Cap.net)).toBeDefined();
    expect(distribution).toEqual({ catalog: [], defaults: {} });
    await opened.composition.dispose();
  });
});
