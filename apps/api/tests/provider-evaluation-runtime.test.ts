import { describe, expect, it } from 'vitest';
import { createProviderEvaluationRuntime } from '../src/provider-evaluation-runtime.ts';

describe('provider evaluation runtime installation gate', () => {
  it('is disabled unless the installation flag is exactly true', () => {
    const options = {} as Parameters<typeof createProviderEvaluationRuntime>[0];
    expect(createProviderEvaluationRuntime(options, {})).toBeUndefined();
    expect(
      createProviderEvaluationRuntime(options, { OVO_PROVIDER_EVALUATIONS_ENABLED: 'TRUE' }),
    ).toBeUndefined();
    expect(
      createProviderEvaluationRuntime(
        {
          ledger: {} as never,
          secrets: {} as never,
          store: {} as never,
          inferenceFactory: {} as never,
          authorizations: { get: async () => undefined },
        },
        { OVO_PROVIDER_EVALUATIONS_ENABLED: 'true' },
      ),
    ).toMatchObject({
      providerGate: expect.any(Object),
      providerExecutor: expect.any(Object),
      releases: expect.any(Object),
    });
  });
});
