import { describe, expect, it } from 'vitest';
import type { Inference } from '@winsendotai/ovo-contracts';
import type {
  CostLedgerService,
  InferenceUsageEvidence,
  RecordUsageInput,
} from '@winsendotai/ovo-plugin-ledger';
import { FIXTURE_RELEASES } from '../src/corpus/index.ts';
import { LedgerProviderEvaluationGate } from '../src/provider-gate.ts';
import { ProviderEvaluationExecutor } from '../src/provider-executor.ts';
import { StaticProviderEvaluationAuthorizations } from '../src/provider-policy.ts';
import type { EvaluationCase, EvaluationRun, ReleaseEvaluationSnapshot } from '../src/types.ts';

describe('provider-backed evaluations', () => {
  it('requires the immutable admin budget policy and reserves real ledger capacity', async () => {
    const ledger = mockLedger();
    const release = providerRelease('100');
    const gate = new LedgerProviderEvaluationGate(
      ledger.service,
      {
        async load() {
          return release;
        },
      },
      new StaticProviderEvaluationAuthorizations([
        {
          id: 'authorization-a',
          workspaceId: 'workspace-a',
          releaseId: release.id,
          releaseFingerprint: release.fingerprint,
          bindingVersion: BINDING_VERSION,
          provider: 'openai',
          modelId: 'gpt-evaluation',
          budgetId: 'evaluation-budget',
          maximumReservationPaise: '100',
          createdBy: 'admin',
          createdAt: '2026-09-20T00:00:00.000Z',
        },
        {
          id: 'authorization-small',
          workspaceId: 'workspace-a',
          releaseId: release.id,
          releaseFingerprint: release.fingerprint,
          bindingVersion: BINDING_VERSION,
          provider: 'openai',
          modelId: 'gpt-evaluation',
          budgetId: 'evaluation-budget',
          maximumReservationPaise: '99',
          createdBy: 'admin',
          createdAt: '2026-09-20T00:00:00.000Z',
        },
      ]),
    );
    await gate.authorize({
      workspaceId: 'workspace-a',
      datasetId: 'dataset-a',
      datasetVersion: 1,
      releaseId: release.id,
      fixtureBindingVersion: BINDING_VERSION,
      budgetAuthorizationId: 'authorization-a',
      idempotencyKey: 'request-a',
    });
    expect(ledger.reservations).toHaveLength(1);
    expect(ledger.reservations[0]).toMatchObject({
      budgetId: 'evaluation-budget',
      amountPaise: '100',
    });

    await expect(
      gate.authorize({
        workspaceId: 'workspace-a',
        datasetId: 'dataset-a',
        datasetVersion: 1,
        releaseId: release.id,
        fixtureBindingVersion: BINDING_VERSION,
        budgetAuthorizationId: 'another-authorization',
        idempotencyKey: 'request-b',
      }),
    ).rejects.toMatchObject({ code: 'provider_evaluation_not_authorized' });
    expect(ledger.reservations).toHaveLength(1);
    await expect(
      gate.authorize({
        workspaceId: 'workspace-a',
        datasetId: 'dataset-a',
        datasetVersion: 1,
        releaseId: release.id,
        fixtureBindingVersion: BINDING_VERSION,
        budgetAuthorizationId: 'authorization-small',
        idempotencyKey: 'request-small',
      }),
    ).rejects.toMatchObject({ code: 'provider_evaluation_not_authorized' });
    expect(ledger.reservations).toHaveLength(1);
  });

  it('runs provider inference through fixture-only tools and records native usage provenance', async () => {
    const ledger = mockLedger();
    const release = providerRelease('100');
    let calls = 0;
    const executor = new ProviderEvaluationExecutor({
      ledger: ledger.service,
      inference: factory(async (request, onUsage) => {
        calls += 1;
        await onUsage(usage(`provider-${calls}`));
        return calls === 1
          ? { kind: 'tool', toolId: 'lookup', input: { account: 'A-1' } }
          : { kind: 'text', text: `status:${String(request.results[0]?.result)}` };
      }),
    });
    const result = await executor.executeCase(run(), release, agentCase());
    expect(result.error).toBeUndefined();
    expect(result.operations).toEqual([{ toolId: 'lookup', state: 'succeeded', confirmed: false }]);
    expect(calls).toBe(2);
    expect(ledger.usage).toHaveLength(8);
    expect(result.provenance).toEqual({
      executor: 'provider',
      bindingVersion: BINDING_VERSION,
      provider: 'openai',
      modelId: 'gpt-evaluation',
      providerRequestIds: ['provider-1', 'provider-2'],
      usageEvidence: 'reported',
      usageReasons: [],
    });
    await executor.finalizeRun(run());
    await executor.finalizeRun(run());
    expect(ledger.settlements).toEqual([{ reservationId: expect.any(String), actualPaise: '8' }]);
  });

  it('halts further requests at the authorized ledger amount', async () => {
    const ledger = mockLedger();
    const release = providerRelease('3');
    let calls = 0;
    const executor = new ProviderEvaluationExecutor({
      ledger: ledger.service,
      inference: factory(async (_request, onUsage) => {
        calls += 1;
        await onUsage(usage(`provider-${calls}`));
        return { kind: 'tool', toolId: 'lookup', input: { account: 'A-1' } };
      }),
    });
    const result = await executor.executeCase(run(), release, agentCase());
    expect(calls).toBe(1);
    expect(result.error).toContain('evaluation-budget-exhausted');
    expect(ledger.usage).toHaveLength(4);
  });

  it('cancels at the case deadline and retains the reservation when usage is unknown', async () => {
    const ledger = mockLedger();
    const release = providerRelease('100');
    const executor = new ProviderEvaluationExecutor({
      ledger: ledger.service,
      maxCaseDurationMs: 10,
      inference: factory(
        (request) =>
          new Promise((_resolve, reject) => {
            request.signal.addEventListener('abort', () => reject(request.signal.reason), {
              once: true,
            });
          }),
      ),
    });
    const currentRun = run();
    const result = await executor.executeCase(currentRun, release, agentCase());
    expect(result.error).toContain('provider-request-outcome-unknown');
    expect(result.provenance?.usageEvidence).toBe('unknown');
    expect(result.provenance?.usageReasons).toContain('provider-request-outcome-unknown');
    await executor.finalizeRun(currentRun);
    await executor.finalizeRun(currentRun);
    expect(ledger.settlements).toEqual([]);
  });
});

const BINDING_VERSION = 'inference-binding:2026-09-20T00:00:00.000Z';

function providerRelease(reservationPaise: string): ReleaseEvaluationSnapshot {
  return {
    ...FIXTURE_RELEASES.agent,
    workspaceId: 'workspace-a',
    agentId: 'agent-a',
    config: {
      ...FIXTURE_RELEASES.agent.config,
      costPolicy: {
        budgetId: 'evaluation-budget',
        reservationPaise,
        maxCallSeconds: 60,
        priceCards: Object.fromEntries(
          [
            'uncached_input_tokens',
            'cache_read_input_tokens',
            'cache_write_input_tokens',
            'output_tokens',
          ].map((unit) => [`openai.inference.${unit}`, { id: `price-${unit}`, version: 'v1' }]),
        ),
      },
    },
    providerBindings: {
      inference: {
        id: 'inference-binding',
        workspaceId: 'workspace-a',
        provider: 'openai',
        credentialId: 'credential-a',
        config: { model: 'gpt-evaluation', api: 'responses' },
        updatedAt: '2026-09-20T00:00:00.000Z',
      },
    },
  };
}

function run(): EvaluationRun {
  return {
    id: 'run-a',
    workspaceId: 'workspace-a',
    datasetId: 'dataset-a',
    datasetVersion: 1,
    datasetFingerprint: 'sha256:dataset',
    releaseId: FIXTURE_RELEASES.agent.id,
    releaseFingerprint: FIXTURE_RELEASES.agent.fingerprint,
    fixtureBindingVersion: BINDING_VERSION,
    executorKind: 'provider',
    budgetAuthorizationId: 'authorization-a',
    idempotencyKey: 'request-a',
    status: 'running',
    attempt: 1,
    maxAttempts: 1,
    ownerId: 'worker-a',
    ownerEpoch: 1,
    passed: 0,
    failed: 0,
    total: 1,
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
  };
}

function agentCase(): EvaluationCase {
  return {
    id: 'provider-tool-case',
    mode: 'agent',
    title: 'Provider inference uses safe fixture tools',
    tags: ['provider'],
    turns: [{ input: 'Look up A-1', variables: {} }],
    expected: {},
    fixture: { toolResults: { lookup: { state: 'active' } } },
  };
}

function usage(requestId: string): InferenceUsageEvidence {
  return {
    requestId,
    modelId: 'gpt-evaluation',
    usage: {
      inputTokens: 10,
      uncachedInputTokens: 5,
      cacheReadInputTokens: 3,
      cacheWriteInputTokens: 2,
      outputTokens: 4,
      totalTokens: 14,
    },
  };
}

function factory(
  generate: (
    request: Parameters<Inference['generate']>[0],
    onUsage: (evidence: InferenceUsageEvidence) => Promise<void>,
  ) => ReturnType<Inference['generate']>,
) {
  return {
    async create(input: { onUsage(evidence: InferenceUsageEvidence): Promise<void> }) {
      return { generate: (request) => generate(request, input.onUsage) } satisfies Inference;
    },
  };
}

function mockLedger() {
  const usageRows: RecordUsageInput[] = [];
  const reservations: Array<{ budgetId: string; amountPaise: string }> = [];
  const settlements: Array<{ reservationId: string; actualPaise: string }> = [];
  const budget = () => ({
    id: 'evaluation-budget',
    workspaceId: 'workspace-a',
    limitPaise: '1000',
    admissionOverspendPaise: '0',
    spentPaise: '0',
    reservedPaise: '0',
    availableForAdmissionPaise: '1000',
    overLimit: false,
  });
  const service = {
    async getBudget() {
      return budget();
    },
    async getPriceCard(id: string) {
      const unit = id.replace('price-', '');
      return {
        id,
        version: 'v1',
        provider: 'openai',
        unit,
        currency: 'INR',
        minorUnitsPerBlock: '1',
        blockQuantity: '1',
        effectiveAt: '2026-09-20T00:00:00.000Z',
        provenance: 'test',
      };
    },
    async reserveBudget(input: { budgetId: string; amountPaise: string; reservationId: string }) {
      reservations.push(input);
      return {
        admitted: true,
        reservationId: input.reservationId,
        state: 'reserved' as const,
        budget: budget(),
      };
    },
    async recordUsage(input: RecordUsageInput) {
      usageRows.push(input);
      return {
        usageId: `usage-${usageRows.length}`,
        chargeId: `charge-${usageRows.length}`,
        state: 'estimated' as const,
        nativeQuantity: input.quantity,
        nativeUnit: input.unit,
        nativeAmountMinor: '1',
        nativeCurrency: 'INR',
        amountPaise: '1',
        priceCard: input.priceCard,
      };
    },
    async getSessionCost(workspaceId: string, sessionId: string) {
      return {
        workspaceId,
        sessionId,
        currency: 'INR' as const,
        estimatedPaise: String(usageRows.length),
        reconciledPaise: '0',
        totalPaise: String(usageRows.length),
      };
    },
    async settleReservation(reservationId: string, actualPaise: string) {
      settlements.push({ reservationId, actualPaise });
      return {
        admitted: true,
        reservationId,
        state: 'settled' as const,
        budget: budget(),
      };
    },
  } as unknown as CostLedgerService;
  return { service, usage: usageRows, reservations, settlements };
}
