import { describe, expect, it, vi } from 'vitest';
import type {
  DurableJob,
  DurableJobStore,
  TelephonyControl,
} from '@winsendotai/ovo-plugin-orchestration';
import type { CostLedgerService } from '@winsendotai/ovo-plugin-ledger';
import type { ControlStore, ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import { definePlugin, PluginRegistry } from '@winsendotai/ovo-runtime';
import { LIVE_COST_METER_KEYS, ProductionWorkerCostRuntime } from '../src/cost-runtime.ts';

const jobId = '00000000-0000-4000-8000-000000000001';
const job = { id: jobId, workspaceId: 'workspace-1', ownerEpoch: 1 } as DurableJob;
const TTS_KEY = 'fixture-tts.streaming-tts.characters';

describe('cost admission refuses a card priced for another model (Wave 2 deferred #8)', () => {
  it('blocks before the budget is reserved when the TTS card names a different model', async () => {
    const { costs, ledger } = selectedRuntime({ model: 'flash_v2_5' }, 'turbo_v2_5');
    expect(await costs.reserve(job, { kind: 'live', releaseId: RELEASE_ID }, jobId)).toMatchObject({
      admitted: false,
      reason: `price_unknown_for_model:${TTS_KEY}`,
    });
    expect(ledger.reserveBudget).not.toHaveBeenCalled();
  });

  it('uses the binding schema default when the binding leaves the model unset', async () => {
    const { costs, ledger } = selectedRuntime({}, 'flash_v2_5');
    expect(await costs.reserve(job, { kind: 'live', releaseId: RELEASE_ID }, jobId)).toMatchObject({
      admitted: false,
      reason: `price_unknown_for_model:${TTS_KEY}`,
    });
    expect(ledger.reserveBudget).not.toHaveBeenCalled();
  });

  it.each([
    ['the same model, compared without case', 'FLASH_V2_5'],
    ['a wildcard card with no model', undefined],
  ])('admits %s', async (_label, cardModel) => {
    const { costs, ledger } = selectedRuntime({ model: 'flash_v2_5' }, cardModel);
    expect(await costs.reserve(job, { kind: 'live', releaseId: RELEASE_ID }, jobId)).toMatchObject({
      admitted: true,
    });
    expect(ledger.reserveBudget).toHaveBeenCalledOnce();
  });

  it('checks the legacy LLM binding model when no registry resolves selections', async () => {
    const release = baseRelease('context', {
      [LIVE_COST_METER_KEYS.carrier]: ref('carrier'),
      [LIVE_COST_METER_KEYS.tts]: ref('tts'),
      [LIVE_COST_METER_KEYS.stt]: ref('stt'),
      [LIVE_COST_METER_KEYS.inference.uncachedInput]: ref('uncached'),
      [LIVE_COST_METER_KEYS.inference.cacheReadInput]: ref('cache-read'),
      [LIVE_COST_METER_KEYS.inference.cacheWriteInput]: ref('cache-write'),
      [LIVE_COST_METER_KEYS.inference.output]: ref('output'),
    });
    release.providerBindings.inference = binding('openai', { model: 'gpt-6-luna' });
    const ledger = ledgerFor((id) => (['uncached', 'output'].includes(id) ? 'gpt-4o-mini' : null));
    const costs = runtime(release, ledger);
    expect(await costs.reserve(job, { kind: 'live', releaseId: release.id }, jobId)).toMatchObject({
      admitted: false,
      reason: `price_unknown_for_model:${[
        LIVE_COST_METER_KEYS.inference.output,
        LIVE_COST_METER_KEYS.inference.uncachedInput,
      ]
        .sort()
        .join(',')}`,
    });
    expect(ledger.reserveBudget).not.toHaveBeenCalled();
  });
});

const RELEASE_ID = '00000000-0000-4000-8000-000000000002';

function selectedRuntime(bindingConfig: Record<string, unknown>, cardModel: string | undefined) {
  const release = baseRelease('announcement', { [TTS_KEY]: ref('tts') });
  release.selections = {
    tts: {
      pluginId: 'fixture-tts',
      version: '1.0.0',
      bindingId: 'tts-binding',
      binding: binding('fixture-tts', bindingConfig),
      config: {},
    },
  } as unknown as ReleaseRecord['selections'];
  const ledger = ledgerFor((id) => (id === 'tts' ? (cardModel ?? null) : null));
  return { costs: runtime(release, ledger, registry()), ledger };
}

function runtime(release: ReleaseRecord, ledger: CostLedgerService, plugins?: PluginRegistry) {
  return new ProductionWorkerCostRuntime(
    ledger,
    { getRelease: vi.fn(async () => release) } as unknown as ControlStore,
    {} as DurableJobStore,
    {} as TelephonyControl,
    'worker-1',
    true,
    plugins,
    { engine: '' },
  );
}

function ledgerFor(model: (id: string) => string | null) {
  return {
    getBudget: vi.fn(async () => ({ workspaceId: 'workspace-1' })),
    getPriceCard: vi.fn(async (id: string, version: string) => {
      const named = model(id);
      return {
        id,
        version,
        provider: 'fixture',
        unit: 'characters',
        currency: 'INR',
        ...(named ? { model: named } : {}),
      };
    }),
    getFxVersion: vi.fn(),
    reserveBudget: vi.fn(async () => ({ admitted: true, state: 'reserved' })),
  } as unknown as CostLedgerService & { reserveBudget: ReturnType<typeof vi.fn> };
}

function registry() {
  return new PluginRegistry([
    definePlugin(
      {
        id: 'fixture-tts',
        version: '1.0.0',
        contractVersion: 2,
        kind: 'tts',
        provider: 'fixture-tts',
        scope: 'session',
        provides: [],
        requires: [],
        configSchema: { type: 'object' },
        bindingSchema: {
          type: 'object',
          properties: { model: { type: 'string', default: 'turbo_v2_5' } },
        },
        secretFields: [],
        capabilities: {
          languages: ['*'],
          interim: false,
          wordTimestamps: false,
          turnSignals: [],
          forceEndpoint: false,
          outputFormats: [],
        },
        meters: [{ key: TTS_KEY, unit: 'characters', role: 'tts', label: 'Fixture TTS' }],
        runtime: { egressHosts: [], modelLicences: [] },
        conformance: ['tts@1'],
      } as never,
      () => undefined,
    ),
  ]);
}

function binding(provider: string, config: Record<string, unknown>) {
  return {
    id: `${provider}-binding`,
    workspaceId: 'workspace-1',
    label: provider,
    provider,
    pluginId: provider,
    environment: 'test',
    credentialId: 'credential',
    config,
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
  };
}

function ref(id: string) {
  return { id, version: 'v1' };
}

function baseRelease(
  mode: ReleaseRecord['config']['mode'],
  priceCards: Record<string, { id: string; version: string }>,
): ReleaseRecord {
  return {
    id: RELEASE_ID,
    workspaceId: 'workspace-1',
    agentId: '00000000-0000-4000-8000-000000000003',
    draftVersion: 1,
    config: {
      name: 'Model pricing',
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
      processing: { initial: 'Wait.', progressAfterMs: 5_000, maxProgress: 1, failure: 'Failed.' },
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
