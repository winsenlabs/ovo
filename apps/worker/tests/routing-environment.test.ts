import { afterEach, describe, expect, it, vi } from 'vitest';
import { routingWorkerOptions } from '../src/worker-environment.ts';

describe('the worker routing environment (Wave 15)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps the external engine off and the prepare bound at 2500 ms by default', () => {
    vi.stubEnv('OVO_ROUTING_EXTERNAL_ENABLED', undefined);
    vi.stubEnv('OVO_ROUTING_PREPARE_TIMEOUT_MS', '');
    expect(routingWorkerOptions()).toEqual({ externalEnabled: false, prepareTimeoutMs: 2_500 });
  });

  it('turns the external engine on only for the exact value true', () => {
    vi.stubEnv('OVO_ROUTING_EXTERNAL_ENABLED', 'TRUE');
    expect(routingWorkerOptions().externalEnabled).toBe(false);
    vi.stubEnv('OVO_ROUTING_EXTERNAL_ENABLED', 'true');
    expect(routingWorkerOptions().externalEnabled).toBe(true);
  });

  it('reads the prepare bound within 500-10000 ms and refuses anything else', () => {
    vi.stubEnv('OVO_ROUTING_PREPARE_TIMEOUT_MS', '4000');
    expect(routingWorkerOptions().prepareTimeoutMs).toBe(4_000);
    for (const value of ['499', '10001', '2.5s'])
      expect(() => {
        vi.stubEnv('OVO_ROUTING_PREPARE_TIMEOUT_MS', value);
        routingWorkerOptions();
      }).toThrow('OVO_ROUTING_PREPARE_TIMEOUT_MS must be an integer between 500 and 10000');
  });
});
