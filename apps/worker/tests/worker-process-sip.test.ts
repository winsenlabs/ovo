import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@winsendotai/ovo-distribution', () => ({
  loadDistribution: vi.fn(async () => ({ catalog: [], defaults: {} })),
}));
vi.mock('../src/worker-environment.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/worker-environment.ts')>()),
  durableAdapterPlugins: () => ({ definitions: [], rows: [] }),
}));

const { openWorkerProcess } = await import('../src/worker-process.ts');

afterEach(() => vi.unstubAllEnvs());

describe('openWorkerProcess with SIP enabled (Wave 11)', () => {
  it('refuses to start without the sip-gateway control token, whether or not it may dial', async () => {
    for (const live of ['false', 'true']) {
      vi.stubEnv('OVO_LIVE_DIAL_ENABLED', live);
      vi.stubEnv('OVO_SIP_ENABLED', 'true');
      vi.stubEnv('OVO_SIP_CONTROL_TOKEN', '');
      await expect(openWorkerProcess()).rejects.toThrow(
        'OVO_SIP_CONTROL_TOKEN is required when OVO_SIP_ENABLED=true',
      );
    }
  });
});
