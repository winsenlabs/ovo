import { describe, expect, it } from 'vitest';
import { createProviderEvaluationRuntime } from '../src/provider-evaluation-runtime.ts';

describe('provider evaluation runtime installation gate', () => {
  it('is disabled unless the installation flag is exactly true', () => {
    const options = {} as Parameters<typeof createProviderEvaluationRuntime>[0];
    expect(createProviderEvaluationRuntime(options, {})).toBeUndefined();
    expect(
      createProviderEvaluationRuntime(options, { OVO_PROVIDER_EVALUATIONS_ENABLED: 'TRUE' }),
    ).toBeUndefined();
    expect(() =>
      createProviderEvaluationRuntime(
        {
          ledger: {} as never,
          secrets: {} as never,
          store: {} as never,
          inferenceFactory: {} as never,
          authorizations: [],
        },
        { OVO_PROVIDER_EVALUATIONS_ENABLED: 'true' },
      ),
    ).toThrow('admin-authorized budget policy');
    expect(
      createProviderEvaluationRuntime(
        {
          ledger: {} as never,
          secrets: {} as never,
          store: {} as never,
          inferenceFactory: {} as never,
          authorizations: [
            {
              id: 'authorization-a',
              workspaceId: 'workspace-a',
              releaseId: 'release-a',
              bindingVersion: 'binding-a:version-a',
              budgetId: 'budget-a',
              maximumReservationPaise: '1',
            },
          ],
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
