import { describe, expect, it, vi } from 'vitest';
import {
  createEvaluationApiRuntime,
  EvaluationApiRuntime,
  EVALUATION_FIXTURE_BINDING_VERSION,
} from '../src/evaluation-runtime.ts';

describe('evaluation API runtime', () => {
  it('runs one bounded fixture worker loop and shuts down its pool', async () => {
    const close = vi.fn(async () => undefined);
    const end = vi.fn(async () => undefined);
    const runOnce = vi.fn(async () => undefined);
    const runtime = new EvaluationApiRuntime(
      { close } as never,
      { runOnce } as never,
      'fixture-worker',
      5,
      2,
      vi.fn(),
      { end } as never,
    );
    runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 15));
    await runtime.stop();
    const callsAfterStop = runOnce.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(EVALUATION_FIXTURE_BINDING_VERSION).toBe('ovo-session-fixtures-v1');
    expect(runOnce).toHaveBeenCalled();
    expect(runOnce).toHaveBeenCalledTimes(callsAfterStop);
    expect(close).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });

  it('validates every option before allocating or connecting a PostgreSQL pool', async () => {
    const store = { getRelease: vi.fn() };
    await expect(
      createEvaluationApiRuntime({
        databaseUrl: 'postgresql://127.0.0.1:1/would-leak-if-contacted',
        store,
        pollIntervalMs: 49,
      }),
    ).rejects.toThrow('pollIntervalMs must be between 50 and 60000');
    await expect(
      createEvaluationApiRuntime({
        databaseUrl: 'postgresql://127.0.0.1:1/would-leak-if-contacted',
        store,
        workerId: '   ',
      }),
    ).rejects.toThrow('workerId is required');
    await expect(
      createEvaluationApiRuntime({
        databaseUrl: 'postgresql://127.0.0.1:1/would-leak-if-contacted',
        store,
        environment: { OVO_PROVIDER_EVALUATIONS_ENABLED: 'true' },
      }),
    ).rejects.toThrow('Provider evaluation dependencies are required when enabled');
    await expect(
      createEvaluationApiRuntime({
        databaseUrl: 'postgresql://127.0.0.1:1/would-leak-if-contacted',
        store,
        environment: { OVO_PROVIDER_EVALUATIONS_ENABLED: 'true' },
        providerEvaluations: {
          ledger: {} as never,
          secrets: {} as never,
          maxProviderRequestsPerCase: 21,
        },
      }),
    ).rejects.toThrow('providerEvaluations.maxProviderRequestsPerCase must be between 1 and 20');
  });

  it('closes its pool even when service cleanup fails', async () => {
    const end = vi.fn(async () => undefined);
    const runtime = new EvaluationApiRuntime(
      { close: vi.fn(async () => Promise.reject(new Error('service-close-failed'))) } as never,
      { runOnce: vi.fn() } as never,
      'fixture-worker',
      5,
      2,
      vi.fn(),
      { end } as never,
    );

    await expect(runtime.stop()).rejects.toThrow('service-close-failed');
    expect(end).toHaveBeenCalledOnce();
  });
});
