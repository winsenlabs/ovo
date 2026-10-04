import { describe, expect, it, vi } from 'vitest';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import { PluginRegistry } from '@winsendotai/ovo-runtime';
import type { CostLedgerService } from '@winsendotai/ovo-plugin-ledger';
import type { ControlStore, ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import type {
  DurableJob,
  DurableJobStore,
  TelephonyControl,
} from '@winsendotai/ovo-plugin-orchestration';
import { createNativeVoiceEngineV2Plugin } from '@winsendotai/ovo-plugin-voice';
import { deepgramPlugin } from '../../../packages/plugin-stt-deepgram/src/index.ts';
import { openAiTtsPlugin } from '../../../packages/plugin-tts-openai/src/index.ts';
import { openAiInferencePlugin } from '../../../packages/plugin-llm-openai/src/index.ts';
import { ProductionWorkerCostRuntime } from '../src/cost-runtime.ts';

const models = [
  ['tts-1', ['characters']],
  ['tts-1-hd', ['characters']],
  ['gpt-4o-mini-tts', ['input_tokens', 'audio_output_tokens']],
  ['gpt-4o-mini-tts-2025-12-15', ['input_tokens', 'audio_output_tokens']],
] as const;
const registry = new PluginRegistry([
  createNativeVoiceEngineV2Plugin(),
  deepgramPlugin,
  openAiTtsPlugin,
  openAiInferencePlugin,
]);

describe('production legacy TTS cost admission', () => {
  it.each(models)(
    'refuses %s with no TTS price cards before any budget reservation',
    async (model, units) => {
      const release = legacyRelease(model);
      const { costs, ledger, job } = runtime(release);
      const result = await costs.reserve(job, job.payload, 'session');
      expect(result).toMatchObject({
        admitted: false,
        reason: `cost-meter-unconfigured:${units.map((unit) => `openai.streaming-tts.${unit}`).join(',')}`,
      });
      expect(ledger.getBudget).not.toHaveBeenCalled();
      expect(ledger.reserveBudget).not.toHaveBeenCalled();
      expect(costs.usageForJob(job.id)).toBeUndefined();
    },
  );

  describe.each(['legacy', 'v2'] as const)('%s selection shape', (shape) => {
    it.each(models)('admits %s with exactly its own TTS meter cards', async (model, units) => {
      const release = legacyRelease(model);
      for (const unit of units) {
        const key = `openai.streaming-tts.${unit}`;
        release.config.costPolicy!.priceCards[key] = { id: key, version: 'v1' };
      }
      if (shape === 'v2') {
        release.selections = Object.fromEntries(
          Object.entries(release.providerBindings).map(([role, binding]) => {
            const definition = registry.resolve(
              role === 'inference' ? 'llm' : (role as 'stt' | 'tts'),
              binding.provider,
            );
            return [
              role === 'inference' ? 'llm' : role,
              {
                pluginId: definition.manifest.id,
                version: definition.manifest.version,
                bindingId: binding.id,
                config: {},
                binding: {
                  provider: binding.provider,
                  config: binding.config,
                  credentialId: binding.credentialId,
                  updatedAt: binding.updatedAt,
                  fingerprint: 'fixture-fingerprint',
                },
              },
            ];
          }),
        );
      }
      const { costs, ledger, job } = runtime(release);
      const result = await costs.reserve(job, job.payload, 'session');
      expect(result.admitted).toBe(true);
      expect(ledger.reserveBudget).toHaveBeenCalledOnce();
      expect(ledger.getPriceCard.mock.calls.map(([id]) => id).sort()).toEqual(
        Object.keys(release.config.costPolicy!.priceCards).sort(),
      );
      await result.releaseBeforeStart();
    });
  });
});

function legacyRelease(model: string): ReleaseRecord {
  const priceCards = Object.fromEntries(
    [
      'deepgram.streaming-stt.audio_seconds',
      ...[
        'input_tokens',
        'uncached_input_tokens',
        'cache_read_input_tokens',
        'cache_write_input_tokens',
        'output_tokens',
      ].map((unit) => `openai.inference.${unit}`),
    ].map((key) => [key, { id: key, version: 'v1' }]),
  );
  return {
    id: 'release',
    workspaceId: 'workspace',
    agentId: 'agent',
    draftVersion: 1,
    config: AgentConfig.parse({
      name: 'Legacy mixed graph',
      mode: 'context',
      providers: { stt: 'stt-binding', tts: 'tts-binding', inference: 'llm-binding' },
      costPolicy: { budgetId: 'budget', reservationPaise: '100', maxCallSeconds: 60, priceCards },
    }),
    plugins: [],
    mcpTools: {},
    createdAt: '2026-09-27T00:00:00Z',
    createdBy: 'fixture',
    providerBindings: Object.fromEntries(
      [
        ['stt', 'stt-binding', 'deepgram', { model: 'nova-3' }],
        ['tts', 'tts-binding', 'openai', { model, voice: 'alloy' }],
        ['inference', 'llm-binding', 'openai', { model: 'gpt-4o-mini' }],
      ].map(([role, id, provider, config]) => [
        role,
        {
          id,
          provider,
          config,
          workspaceId: 'workspace',
          label: role,
          environment: 'test',
          credentialId: 'credential',
          createdAt: '2026-09-27T00:00:00Z',
          updatedAt: '2026-09-27T00:00:00Z',
        },
      ]),
    ) as ReleaseRecord['providerBindings'],
  };
}

function runtime(release: ReleaseRecord) {
  const ledger = {
    getBudget: vi.fn(async () => ({ workspaceId: 'workspace' })),
    getPriceCard: vi.fn(async (_id: string, _version: string) => ({ currency: 'INR' })),
    reserveBudget: vi.fn(async () => ({ admitted: true })),
    releaseReservation: vi.fn(async () => ({ admitted: true })),
  };
  const job: DurableJob = {
    id: 'job',
    workspaceId: 'workspace',
    idempotencyKey: 'legacy-cost',
    status: 'owned',
    ownerEpoch: 1,
    payload: { releaseId: release.id },
  };
  const costs = new ProductionWorkerCostRuntime(
    ledger as unknown as CostLedgerService,
    { getRelease: async () => release } as unknown as ControlStore,
    {} as DurableJobStore,
    {} as TelephonyControl,
    'worker',
    true,
    registry,
  );
  return { costs, ledger, job };
}
