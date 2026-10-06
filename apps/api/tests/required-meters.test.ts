import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { AgentConfig, Cap, type ReleaseSelections } from '@winsendotai/ovo-contracts';
import { FIRST_PARTY } from '@winsendotai/ovo-distribution';
import { VENDOR_PRICE_CATALOG, type PriceCardVersion } from '@winsendotai/ovo-plugin-ledger';
import {
  definePlugin,
  manifestKeys,
  PluginRegistry,
  type PluginDefinition,
} from '@winsendotai/ovo-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requiredMeterChecklist } from '../src/required-meters.ts';
import { registerRequiredMeterRoutes } from '../src/routes/required-meters.ts';

// OPS-13/14: meter keys were typed by hand and a model swap kept its old price silently.

// 'infra' keeps the manifests minimal; the checklist reads only meters, provider and schema.
const plugin = (
  id: string,
  provider: string,
  meters: { key: string; unit: string; role: string; when?: unknown }[],
  bindingSchema?: Record<string, unknown>,
) =>
  definePlugin(
    {
      id,
      version: '1.0.0',
      contractVersion: 2,
      scope: 'session',
      kind: 'infra',
      provider,
      provides: [Cap.inference],
      requires: [],
      meters: meters.map((meter) => ({ label: meter.key, ...meter })),
      ...(bindingSchema ? { bindingSchema } : {}),
    } as never,
    () => undefined,
  );

const registry = new PluginRegistry([
  plugin('carrier', 'twilio', [
    { key: 'twilio.carrier.audio_seconds', unit: 'audio_seconds', role: 'carrier' },
  ]),
  plugin(
    'tts',
    'elevenlabs',
    [{ key: 'elevenlabs.streaming-tts.characters', unit: 'characters', role: 'tts' }],
    { properties: { model: { type: 'string', default: 'eleven_flash_v2_5' } } },
  ),
  plugin('llm', 'openai', [
    { key: 'openai.inference.input_tokens', unit: 'input_tokens', role: 'llm' },
    { key: 'openai.inference.output_tokens', unit: 'output_tokens', role: 'llm' },
  ]),
]);

const selections = (model: string): ReleaseSelections =>
  ({
    carrier: { pluginId: 'carrier', version: '1.0.0', config: {} },
    tts: { pluginId: 'tts', version: '1.0.0', config: {} },
    llm: {
      pluginId: 'llm',
      version: '1.0.0',
      config: {},
      binding: { provider: 'openai', config: { model }, credentialId: 'c', fingerprint: 'f' },
    },
  }) as unknown as ReleaseSelections;

const card = (overrides: Partial<PriceCardVersion>): PriceCardVersion => ({
  id: 'x',
  version: 'v1',
  provider: 'openai',
  unit: 'input_tokens',
  currency: 'INR',
  minorUnitsPerBlock: '1',
  blockQuantity: '1',
  effectiveAt: '2026-10-06T00:00:00.000Z',
  provenance: 'test',
  ...overrides,
});

const cards: Record<string, PriceCardVersion> = {
  carrier: card({ id: 'carrier', provider: 'twilio', unit: 'audio_seconds' }),
  'luna-in': card({ id: 'luna-in', model: 'gpt-6-luna', provisional: true }),
  'luna-out': card({ id: 'luna-out', unit: 'output_tokens', model: 'gpt-6-luna' }),
  'tts-usd': card({
    id: 'tts-usd',
    provider: 'elevenlabs',
    unit: 'characters',
    currency: 'USD',
    model: 'eleven_flash_v2_5',
  }),
};
const ledger = { getPriceCard: vi.fn(async (id: string) => cards[id]) };

const config = (priceCards: Record<string, { id: string; version: string; fxId?: string }>) =>
  AgentConfig.parse({
    name: 'Agent',
    mode: 'context',
    instructions: 'Help.',
    costPolicy: { budgetId: 'b', reservationPaise: '100', maxCallSeconds: 60, priceCards },
  });

describe('required meter checklist', () => {
  it('lists every meter of the selected plugins with its model and price status', async () => {
    const result = await requiredMeterChecklist({
      config: config({
        'twilio.carrier.audio_seconds': { id: 'carrier', version: 'v1' },
        'openai.inference.input_tokens': { id: 'luna-in', version: 'v1' },
        'openai.inference.output_tokens': { id: 'luna-out', version: 'v1' },
        'elevenlabs.streaming-tts.characters': { id: 'tts-usd', version: 'v1' },
      }),
      selections: selections('gpt-6-luna'),
      registry,
      ledger,
    });
    expect(
      result.meters.map(({ key, slot, model, status }) => ({ key, slot, model, status })),
    ).toEqual([
      { key: 'twilio.carrier.audio_seconds', slot: 'carrier', model: undefined, status: 'covered' },
      {
        key: 'elevenlabs.streaming-tts.characters',
        slot: 'tts',
        model: 'eleven_flash_v2_5',
        status: 'fx_missing',
      },
      { key: 'openai.inference.input_tokens', slot: 'llm', model: 'gpt-6-luna', status: 'covered' },
      {
        key: 'openai.inference.output_tokens',
        slot: 'llm',
        model: 'gpt-6-luna',
        status: 'covered',
      },
    ]);
    expect(result.complete).toBe(false);
    expect(result.provisional).toBe(true);
    // Catalog suggestions match the meter and the model the binding runs.
    expect(result.meters[1]!.catalog.map((entry) => entry.id)).toEqual([
      'elevenlabs-tts-flash-v2-5',
    ]);
    expect(result.meters[2]!.catalog).toEqual([
      expect.objectContaining({ id: 'openai-gpt-6-luna-input', provisional: false }),
    ]);
  });

  it('flags price_unknown_for_model when the binding swapped the model under a priced card', async () => {
    const result = await requiredMeterChecklist({
      config: config({
        'openai.inference.input_tokens': { id: 'luna-in', version: 'v1' },
        'openai.inference.output_tokens': { id: 'carrier', version: 'v1' },
      }),
      selections: selections('gpt-6-sol'),
      registry,
      ledger,
    });
    const status = Object.fromEntries(result.meters.map((meter) => [meter.key, meter.status]));
    expect(status).toEqual({
      'twilio.carrier.audio_seconds': 'missing',
      'elevenlabs.streaming-tts.characters': 'missing',
      'openai.inference.input_tokens': 'price_unknown_for_model',
      'openai.inference.output_tokens': 'unit_mismatch',
    });
    expect(result.meters[2]!.catalog).toEqual([]);
  });

  it('reports a reference to a card the ledger does not hold', async () => {
    const result = await requiredMeterChecklist({
      config: config({ 'twilio.carrier.audio_seconds': { id: 'gone', version: 'v9' } }),
      selections: selections('gpt-6-luna'),
      registry,
      ledger,
    });
    expect(result.meters[0]).toMatchObject({
      status: 'price_card_unavailable',
      reference: { id: 'gone', version: 'v9' },
    });
  });

  it('names only meter keys that installed plugins declare (ElevenLabs lands this wave)', async () => {
    const declared = new Set<string>();
    for (const entry of FIRST_PARTY) {
      const loaded = (await entry.load()) as { plugins?: readonly PluginDefinition[] };
      for (const definition of loaded.plugins ?? [])
        for (const meter of manifestKeys(definition.manifest).manifest.meters ?? [])
          declared.add(meter.key);
    }
    const unknown = VENDOR_PRICE_CATALOG.flatMap((entry) => entry.meterKeys).filter(
      (key) => !declared.has(key),
    );
    expect(unknown.filter((key) => !key.startsWith('elevenlabs.'))).toEqual([]);
  }, 30_000);
});

describe('GET /v1/agents/:agentId/required-meters', () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('answers 404 for an agent outside the workspace', async () => {
    const app = Fastify();
    apps.push(app);
    app.addHook('onRequest', async (request) => {
      (request as FastifyRequest & { principal: unknown }).principal = {
        workspaceId: 'w',
        identityId: 'i',
        role: 'viewer',
      };
    });
    const getAgent = vi.fn(async () => undefined);
    registerRequiredMeterRoutes({
      app,
      store: { getAgent } as never,
      options: {} as never,
      catalog: [],
    });
    const response = await app.inject('/v1/agents/agent-9/required-meters');
    expect(response.statusCode).toBe(404);
    expect(getAgent).toHaveBeenCalledWith('w', 'agent-9');
  });
});
