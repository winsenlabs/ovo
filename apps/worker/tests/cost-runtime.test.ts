import { describe, expect, it, vi } from 'vitest';
import type {
  ClaimedJob,
  DurableJobStore,
  DurableQueue,
  QueueDelivery,
  TaskProtection,
  TelephonyControl,
} from '@winsendotai/ovo-plugin-orchestration';
import type { CostLedgerService } from '@winsendotai/ovo-plugin-ledger';
import type { ControlStore, ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import {
  LIVE_COST_METER_KEYS,
  ProductionWorkerCostRuntime,
  requiredLiveCostMeterKeys,
} from '../src/cost-runtime.ts';
import { WorkerRunner } from '../src/runner.ts';
import { DEFAULT_WORKER_RUNNER_OPTIONS } from '../src/worker-options.ts';

const jobId = '00000000-0000-4000-8000-000000000001';
const delivery: QueueDelivery = {
  messageId: 'message-1',
  receiptHandle: 'receipt-1',
  receiveCount: 1,
  reference: { schemaVersion: 1, jobId },
};

describe('live cost coverage', () => {
  it('derives STT and inference coverage only for release behavior that uses them', () => {
    expect(requiredLiveCostMeterKeys(release('announcement'))).toEqual([
      LIVE_COST_METER_KEYS.carrier,
      LIVE_COST_METER_KEYS.tts,
    ]);
    expect(requiredLiveCostMeterKeys(release('faq'))).toEqual([
      LIVE_COST_METER_KEYS.carrier,
      LIVE_COST_METER_KEYS.tts,
      LIVE_COST_METER_KEYS.stt,
    ]);
    expect(requiredLiveCostMeterKeys(release('context'))).toEqual([
      LIVE_COST_METER_KEYS.carrier,
      LIVE_COST_METER_KEYS.tts,
      LIVE_COST_METER_KEYS.stt,
      LIVE_COST_METER_KEYS.inference.uncachedInput,
      LIVE_COST_METER_KEYS.inference.cacheReadInput,
      LIVE_COST_METER_KEYS.inference.cacheWriteInput,
      LIVE_COST_METER_KEYS.inference.output,
    ]);
  });

  it('accepts an explicit aggregate-input estimate instead of partial disjoint LLM coverage', () => {
    const configured = release('agent', {
      [LIVE_COST_METER_KEYS.inference.aggregateInput]: card('aggregate'),
      [LIVE_COST_METER_KEYS.inference.output]: card('output'),
    });
    delete configured.config.costPolicy!.priceCards[LIVE_COST_METER_KEYS.inference.uncachedInput];
    delete configured.config.costPolicy!.priceCards[LIVE_COST_METER_KEYS.inference.cacheReadInput];
    delete configured.config.costPolicy!.priceCards[LIVE_COST_METER_KEYS.inference.cacheWriteInput];

    expect(requiredLiveCostMeterKeys(configured)).toContain(
      LIVE_COST_METER_KEYS.inference.aggregateInput,
    );
    expect(requiredLiveCostMeterKeys(configured)).not.toContain(
      LIVE_COST_METER_KEYS.inference.uncachedInput,
    );
  });

  it.each([
    ['carrier', LIVE_COST_METER_KEYS.carrier],
    ['TTS', LIVE_COST_METER_KEYS.tts],
  ])('blocks the call before dial when %s coverage is missing', async (_label, missingMeter) => {
    const currentRelease = release('announcement');
    delete currentRelease.config.costPolicy!.priceCards[missingMeter];
    currentRelease.config.costPolicy!.priceCards['unrelated.provider.unit'] = card('unrelated');
    const ledger = ledgerMock();
    const control = {
      getRelease: vi.fn(async () => currentRelease),
    } as unknown as ControlStore;
    const store = workerStore(currentRelease.id);
    const telephony = telephonyMock();
    const costs = new ProductionWorkerCostRuntime(ledger, control, store, telephony, 'worker-1');
    const runner = new WorkerRunner(
      'worker-1',
      store,
      queueMock(),
      { check: vi.fn(async () => ({ ready: true as const })) },
      protectionMock(),
      telephony,
      { ...DEFAULT_WORKER_RUNNER_OPTIONS, cost: costs },
    );

    await expect(runner.handle(delivery)).resolves.toEqual({
      kind: 'failed',
      reason: `cost-meter-unconfigured:${missingMeter}`,
    });
    expect(telephony.dial).not.toHaveBeenCalled();
    expect(ledger.reserveBudget).not.toHaveBeenCalled();
    expect(costs.usageForJob(jobId)).toBeUndefined();
  });
});

function release(
  mode: ReleaseRecord['config']['mode'],
  inferenceCards: Record<string, { id: string; version: string }> = {},
): ReleaseRecord {
  const priceCards = {
    [LIVE_COST_METER_KEYS.carrier]: card('carrier'),
    [LIVE_COST_METER_KEYS.tts]: card('tts'),
    [LIVE_COST_METER_KEYS.stt]: card('stt'),
    [LIVE_COST_METER_KEYS.inference.uncachedInput]: card('uncached'),
    [LIVE_COST_METER_KEYS.inference.cacheReadInput]: card('cache-read'),
    [LIVE_COST_METER_KEYS.inference.cacheWriteInput]: card('cache-write'),
    [LIVE_COST_METER_KEYS.inference.output]: card('output'),
    ...inferenceCards,
  };
  return {
    id: '00000000-0000-4000-8000-000000000002',
    workspaceId: 'workspace-1',
    agentId: '00000000-0000-4000-8000-000000000003',
    draftVersion: 1,
    config: {
      name: 'Cost coverage',
      mode,
      language: 'en-IN',
      locale: 'en-IN',
      timezone: 'Asia/Kolkata',
      message: 'Hello',
      variables: { type: 'object', properties: {}, additionalProperties: false },
      faq: [],
      faqThreshold: 0.65,
      faqMargin: 0.15,
      clarification: 'Please clarify.',
      context: '',
      contextBudget: 1_000,
      uncertainty: 'Unknown.',
      tools: [],
      allowedTools: [],
      processing: {
        initial: 'Please wait.',
        progressAfterMs: 5_000,
        maxProgress: 1,
        failure: 'Failed.',
      },
      maxSteps: 5,
      providers: {},
      recording: false,
      costPolicy: {
        budgetId: 'budget-1',
        reservationPaise: '100',
        maxCallSeconds: 120,
        priceCards,
      },
    },
    plugins: [],
    providerBindings: {},
    mcpTools: {},
    createdAt: '2026-09-20T00:00:00.000Z',
    createdBy: 'admin',
  };
}

function card(id: string) {
  return { id, version: 'v1' };
}

function ledgerMock() {
  return {
    getBudget: vi.fn(),
    getPriceCard: vi.fn(),
    getFxVersion: vi.fn(),
    reserveBudget: vi.fn(),
  } as unknown as CostLedgerService & { reserveBudget: ReturnType<typeof vi.fn> };
}

function workerStore(releaseId: string) {
  const job: ClaimedJob = {
    id: jobId,
    workspaceId: 'workspace-1',
    idempotencyKey: 'call-1',
    status: 'owned',
    ownerId: 'worker-1',
    ownerEpoch: 1,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    payload: { releaseId, callId: jobId },
  };
  return {
    claim: vi.fn(async () => ({ kind: 'execute' as const, job })),
    heartbeat: vi.fn(async () => true),
    markFailed: vi.fn(async () => true),
    requestSessionTermination: vi.fn(),
    getSessionRoute: vi.fn(),
  } as unknown as DurableJobStore;
}

function queueMock() {
  return {
    delete: vi.fn(async () => undefined),
    changeVisibility: vi.fn(async () => undefined),
  } as unknown as DurableQueue;
}

function protectionMock() {
  return {
    establish: vi.fn(async () => true),
    renew: vi.fn(async () => true),
    release: vi.fn(async () => undefined),
  } as TaskProtection;
}

function telephonyMock() {
  return {
    dial: vi.fn(),
    reconcile: vi.fn(),
    hangup: vi.fn(),
    transfer: vi.fn(),
  } as unknown as TelephonyControl & { dial: ReturnType<typeof vi.fn> };
}
