import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AgentConfig,
  Cap,
  type CarrierIngress,
  type CarrierMediaEvent,
  type EngineEvent,
  type ReleaseSelection,
} from '@winsendotai/ovo-contracts';
import {
  FakeClock,
  fixtureLlmPlugin,
  fixtureTemplates as inferenceTemplates,
} from '../../conformance/src/drivers.ts';
import { runFixtureCall } from '@winsendotai/ovo-fixture-calls';
import * as fixtureHost from '../../fixture-calls/src/host-service.ts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { compose, PluginRegistry } from '@winsendotai/ovo-runtime';
import { loadDistribution } from '../src/load.ts';
import { callerHangupTemplate } from './fixture-support.ts';

const IDS = {
  native: '@winsendotai/ovo-plugin-voice-session-engine',
  livekit: '@winsendotai/ovo-engine-livekit',
  twilio: '@winsendotai/ovo-carrier-twilio',
  exotel: '@winsendotai/ovo-carrier-exotel',
  plivo: '@winsendotai/ovo-carrier-plivo',
  deepgram: '@winsendotai/ovo-provider-deepgram-stt',
  assemblyai: '@winsendotai/ovo-stt-assemblyai',
  sarvamStt: '@winsendotai/ovo-stt-sarvam',
  openaiTts: '@winsendotai/ovo-provider-openai-tts',
  sarvamTts: '@winsendotai/ovo-tts-sarvam',
} as const;

function selection(
  registry: PluginRegistry,
  pluginId: string,
  provider?: string,
  config = {},
): ReleaseSelection {
  const definition = registry.get(pluginId);
  if (!definition) throw new Error(`Matrix plugin is not installed: ${pluginId}`);
  return {
    pluginId,
    version: definition.manifest.version,
    ...(provider
      ? {
          bindingId: `fixture-${provider}`,
          binding: {
            provider,
            config,
            credentialId: 'matrix-fixture-credential',
            fingerprint: 'matrix-fixture',
            updatedAt: '2026-10-01T00:00:00Z',
          },
        }
      : {}),
    config: {},
  };
}

const STT = [
  { name: 'deepgram', id: IDS.deepgram, finish: 'CloseStream', binding: { model: 'nova-3' } },
  {
    name: 'assemblyai',
    id: IDS.assemblyai,
    finish: 'Terminate',
    binding: { model: 'universal-streaming-english' },
  },
  { name: 'sarvam', id: IDS.sarvamStt, finish: 'end', binding: { model: 'saaras:v3-realtime' } },
] as const;
const TTS = [
  { name: 'openai', id: IDS.openaiTts, binding: { model: 'gpt-4o-mini-tts', voice: 'alloy' } },
  { name: 'sarvam', id: IDS.sarvamTts, binding: { model: 'bulbul:v3', speaker: 'shubh' } },
] as const;
const CARRIERS = [
  { name: 'twilio', id: IDS.twilio },
  { name: 'plivo', id: IDS.plivo },
] as const;
const ROWS = CARRIERS.flatMap((carrier) =>
  STT.flatMap((stt) => TTS.map((tts) => ({ carrier, stt, tts }))),
);
type Row = (typeof ROWS)[number];

async function runRow(
  loaded: Awaited<ReturnType<typeof loadDistribution>>,
  engineId: string,
  row: Row,
): Promise<void> {
  const { carrier: chosen, stt, tts } = row;
  const registry = new PluginRegistry(loaded.catalog);
  // Both production ingresses coexist in the same process graph, as in the gateway.
  const carrier = await compose([{ id: IDS.twilio }, { id: IDS.plivo }], loaded.catalog, {
    scope: 'process',
    net: createFixtureNet([]),
    enforcement: 'enforce',
  });
  try {
    expect([...carrier.all(Cap.carrierIngress).keys()].sort()).toEqual(['plivo', 'twilio']);
    const ingress = carrier.all(Cap.carrierIngress).get(chosen.name) as CarrierIngress & {
      createFixtureFrameEncoder(): (event: CarrierMediaEvent) => string;
    };
    expect(ingress.carrierId).toBe(chosen.name);
    const clock = engineId === IDS.native ? new FakeClock() : undefined;
    const call = runFixtureCall({
      registry,
      ...(clock ? { clock } : {}),
      fixtures: loaded.fixtures,
      fixtureTemplates: {
        ...loaded.fixtureTemplates,
        [stt.id]: callerHangupTemplate(loaded.fixtureTemplates[stt.id]!, stt.finish),
      },
      fixtureSecrets: { 'matrix-fixture-credential': 'fixture-key' },
      carrier: {
        pluginId: chosen.id,
        ingress,
        inboundFrame: ingress.createFixtureFrameEncoder(),
      },
      release: {
        id: 'matrix-release',
        workspaceId: 'matrix-workspace',
        plugins: [],
        config: AgentConfig.parse({
          name: 'Matrix FAQ',
          mode: 'faq',
          language: 'en-IN',
          faq: [{ id: 'q1', question: 'hello fixture', answer: 'Fixture answer.' }],
          recording: false,
        }),
        selections: {
          engine: selection(registry, engineId),
          carrier: { ...selection(registry, chosen.id), bindingId: 'env' },
          stt: selection(registry, stt.id, stt.name, stt.binding),
          tts: selection(registry, tts.id, tts.name, tts.binding),
        },
      },
      callerScript: { turns: [{ atMs: 0, say: 'hello fixture' }] },
      agentTexts: ['Fixture answer.'],
    });
    if (clock) await clock.advanceAsync(10_000);
    const result = await call.done;
    expect(result.status, JSON.stringify(result.outcome)).toBe('completed');
    expect(result.sttMode).toBe('template');
    expect(result.selections.engine?.id).toBe(engineId);
    expect(result.selections.carrier?.id).toBe(chosen.id);
    expect(result.selections.stt?.id).toBe(stt.id);
    expect(result.selections.tts?.id).toBe(tts.id);
    expect(result.events.some((entry) => entry.event.type === 'user.transcript')).toBe(true);
    expect(result.events.some((entry) => entry.event.type === 'agent.transcript')).toBe(true);
    expect(result.recording).toBeUndefined();
    expect(result.carrierFrames.length).toBeGreaterThan(0);
    expect(result.usage.length).toBeGreaterThan(0);
    expect(result.usage.every((meter) => meter.state === 'estimated')).toBe(true);
  } finally {
    await carrier.dispose();
  }
}

async function runAgentRow(
  loaded: Awaited<ReturnType<typeof loadDistribution>>,
  engineId: string,
  { carrier: chosen, stt, tts }: Row,
): Promise<void> {
  const registry = new PluginRegistry([...loaded.catalog, fixtureLlmPlugin]);
  const carrier = await compose([{ id: IDS.twilio }, { id: IDS.plivo }], loaded.catalog, {
    scope: 'process',
    net: createFixtureNet([]),
    enforcement: 'enforce',
  });
  try {
    const ingress = carrier.all(Cap.carrierIngress).get(chosen.name) as CarrierIngress & {
      createFixtureFrameEncoder(): (event: CarrierMediaEvent) => string;
    };
    const events: EngineEvent[] = [];
    const executions: number[] = [];
    const originalExtensions = fixtureHost.fixtureExtensions;
    vi.spyOn(fixtureHost, 'fixtureExtensions').mockImplementation((...args) => {
      const extensions = originalExtensions(...args);
      const send = extensions.nativeHandlers.send!;
      return {
        ...extensions,
        nativeHandlers: {
          ...extensions.nativeHandlers,
          send: async (...handlerArgs) => {
            executions.push(events.length);
            return send(...handlerArgs);
          },
        },
      };
    });
    const nativePackage = {
      packageName: '@fixture/native',
      packageVersion: '1.0.0',
      pluginId: '@fixture/native-marker',
      pluginVersion: '1.0.0',
      handlerIds: ['send'],
    };
    const clock = engineId === IDS.native ? new FakeClock() : undefined;
    const call = runFixtureCall({
      registry,
      ...(clock ? { clock } : {}),
      fixtures: loaded.fixtures,
      fixtureTemplates: { ...loaded.fixtureTemplates, ...inferenceTemplates },
      fixtureSecrets: { 'matrix-fixture-credential': 'fixture-key' },
      carrier: { pluginId: chosen.id, ingress, inboundFrame: ingress.createFixtureFrameEncoder() },
      installedExtensions: {
        plugins: [],
        nativeHandlers: {
          send: vi.fn(async () => {
            throw new Error('live handler reached');
          }),
        },
        nativeHandlerPackages: [nativePackage],
      },
      release: {
        id: 'matrix-agent-release',
        workspaceId: 'matrix-workspace',
        plugins: [{ id: nativePackage.pluginId, version: nativePackage.pluginVersion }],
        config: AgentConfig.parse({
          name: 'Matrix agent',
          mode: 'agent',
          language: 'en-IN',
          recording: false,
          tools: [
            {
              id: 'send',
              description: 'Send the confirmed update',
              connector: 'native',
              inputSchema: { type: 'object' },
              outputSchema: { type: 'object' },
              effect: 'write',
              confirmation: true,
            },
          ],
          allowedTools: ['send'],
        }),
        selections: {
          engine: selection(registry, engineId),
          carrier: { ...selection(registry, chosen.id), bindingId: 'env' },
          stt: selection(registry, stt.id, stt.name, stt.binding),
          tts: selection(registry, tts.id, tts.name, tts.binding),
          llm: { ...selection(registry, fixtureLlmPlugin.manifest.id), bindingId: 'env' },
        },
      },
      callerScript: 'default',
      telemetry: {
        onEvent: (row) => {
          events.push(row.event);
        },
      },
    });
    if (clock) await clock.advanceAsync(120_000);
    const result = await call.done;
    const promptPlayed = events.findIndex(
      (event) =>
        event.type === 'agent.transcript' &&
        event.state === 'played' &&
        event.text.startsWith('Please confirm:'),
    );
    const yes = events.findIndex(
      (event) =>
        event.type === 'user.transcript' && event.text === 'yes' && event.stability === 'final',
    );
    expect(promptPlayed).toBeGreaterThanOrEqual(0);
    expect(yes).toBeGreaterThan(promptPlayed);
    expect(executions).toHaveLength(1);
    expect(executions[0]).toBeGreaterThan(yes);
    expect(result.status).toBe('completed');
    expect(result.sttMode).toBe('template');
    expect(result.selections.engine?.id).toBe(engineId);
    expect(result.selections.carrier?.id).toBe(chosen.id);
    expect(result.selections.stt?.id).toBe(stt.id);
    expect(result.selections.tts?.id).toBe(tts.id);
  } finally {
    await carrier.dispose();
  }
}

describe('real installed plugin fixture matrix', () => {
  let loaded: Awaited<ReturnType<typeof loadDistribution>>;
  afterEach(() => vi.restoreAllMocks());
  beforeAll(async () => {
    loaded = await loadDistribution({ role: 'gateway', profile: 'compose', env: {} });
  });

  it('holds all Exotel FAQ and confirmed-write rows until its authenticated 16 kHz wire format is confirmed (2026-10-02)', () => {
    const registry = new PluginRegistry(loaded.catalog);
    expect(registry.get(IDS.exotel)).toBeUndefined();
    expect(CARRIERS.map((carrier) => carrier.id)).toEqual([IDS.twilio, IDS.plivo]);
    expect(ROWS).toHaveLength(12); // Twilio/Plivo each contribute six combinations; Exotel contributes zero.
  });

  describe('native engine', () => {
    it.each(ROWS)(
      '$carrier.name × $stt.name × $tts.name FAQ uses real selections and provider templates',
      (row) => runRow(loaded, IDS.native, row),
      60_000,
    );
  });

  it.each(ROWS)(
    'native × $carrier.name × $stt.name × $tts.name executes one confirmed write after playback',
    (row) => runAgentRow(loaded, IDS.native, row),
    60_000,
  );

  describe('LiveKit engine with real timers and serial execution', () => {
    it.each(ROWS)(
      '$carrier.name × $stt.name × $tts.name FAQ uses real selections and provider templates',
      (row) => runRow(loaded, IDS.livekit, row),
      60_000,
    );
    it.each(ROWS)(
      '$carrier.name × $stt.name × $tts.name executes one confirmed write after playback',
      (row) => runAgentRow(loaded, IDS.livekit, row),
      60_000,
    );
  });
});
