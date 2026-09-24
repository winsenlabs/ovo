import type { Behavior } from '@winsendotai/ovo-contracts';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import { createSessionPluginCatalog } from '@winsendotai/ovo-plugin-session';
import { LiveRecordingService } from '@winsendotai/ovo-plugin-recordings';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import { STREAMING_VOICE_SERVICE_KEYS } from '@winsendotai/ovo-plugin-voice';
import { definePlugin, type PluginDefinition } from '@winsendotai/ovo-runtime';
import { compose } from '@winsendotai/ovo-runtime';
import { loadDistribution } from '@winsendotai/ovo-distribution';
import { MULAW_8K } from '@winsendotai/ovo-contracts';
import { describe, expect, it, vi } from 'vitest';
import { ProductionVoiceSessionFactory } from '../src/production-session-factory.ts';
import { selectVoiceSessionEnginePlugin } from '../src/production-session-support.ts';

describe('production worker voice session engine selection', () => {
  it('runs one release-pinned replacement with the unchanged behavior and lifecycle', async () => {
    const events: string[] = [];
    const applied = vi.fn();
    let engineConfig: Record<string, unknown> | undefined;
    let behaviorOutput: string | undefined;
    const replacement = replacementEngine('@example/voice-engine', '1.0.0', async (ctx, config) => {
      applied();
      engineConfig = config;
      behaviorOutput = await (ctx.get('ovo.behavior') as Behavior).respond('', {});
      ctx.provide(STREAMING_VOICE_SERVICE_KEYS.sessionEngine, {
        dispose: async () => {
          events.push('engine');
        },
      });
      ctx.effect(() => () => {
        events.push('plugin');
      });
    });
    const recordingStates: string[] = [];
    const release = releaseWithPins(true, [pin(replacement)]);
    const factory = await createFactory(
      release,
      [replacement],
      events,
      recordingService(recordingStates),
    );

    const session = await factory.create(factoryInput());

    expect(applied).toHaveBeenCalledOnce();
    expect(behaviorOutput).toBe('Welcome from the unchanged behavior');
    expect(engineConfig).toMatchObject({
      language: release.config.language,
      inputEnabled: false,
      initialInput: '',
      initialVariables: {},
    });
    await session.dispose('behavior_completed');
    expect(events).toEqual(['engine', 'plugin', 'telemetry']);
    expect(recordingStates).toEqual(['active', 'finalizing', 'available']);
  });

  it('keeps the built-in engine definition as the fallback when no replacement is installed', () => {
    const release = releaseWithPins(false, []);
    const fallback = replacementEngine('@winsendotai/ovo-plugin-voice-session-engine', '0.1.0');
    const createFallback = vi.fn(() => fallback);

    const selected = selectVoiceSessionEnginePlugin(release, [], createFallback);

    expect(selected).toBe(fallback);
    expect(createFallback).toHaveBeenCalledOnce();
  });

  it('ignores unselected installed engines when keeping the fallback or choosing a pinned engine', () => {
    const selected = replacementEngine('@example/selected-engine');
    const unrelated = replacementEngine('@example/unselected-engine');
    const fallback = replacementEngine('@example/fallback-engine');
    const createFallback = vi.fn(() => fallback);
    expect(
      selectVoiceSessionEnginePlugin(releaseWithPins(false, []), [unrelated], createFallback),
    ).toBe(fallback);
    expect(
      selectVoiceSessionEnginePlugin(
        releaseWithPins(false, [pin(selected)]),
        [selected, unrelated],
        createFallback,
      ),
    ).toBe(selected);
    expect(createFallback).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: 'a selected engine with an invalid dependency graph',
      plugins: [
        definePlugin(
          {
            ...replacementEngine('@example/invalid-engine').manifest,
            requires: ['ovo.behavior', 'missing.engine-port'],
          },
          () => undefined,
        ),
      ],
      pins: (plugins: PluginDefinition[]) => plugins.map(pin),
      message: 'Missing service missing.engine-port',
    },
    {
      name: 'multiple replacement providers',
      plugins: [replacementEngine('@example/engine-a'), replacementEngine('@example/engine-b')],
      pins: (plugins: PluginDefinition[]) => plugins.map(pin),
      message: 'multiple installed voice session engine providers',
    },
    {
      name: 'a stale replacement pin',
      plugins: [replacementEngine('@example/stale-engine', '2.0.0')],
      pins: () => [{ id: '@example/stale-engine', version: '1.0.0' }],
      message: 'does not satisfy release pin',
    },
    {
      name: 'an expected replacement that is not installed',
      plugins: [],
      pins: () => [{ id: '@example/missing-engine', version: '1.0.0' }],
      message: 'live release plugin is not installed',
    },
  ])('fails before apply and closes acquired resources for $name', async (fixture) => {
    const apply = vi.fn();
    const plugins = fixture.plugins.map((plugin) =>
      definePlugin(plugin.manifest, async () => {
        apply();
      }),
    );
    const release = releaseWithPins(true, fixture.pins(plugins));
    const events: string[] = [];
    const recordingStates: string[] = [];
    const recordings = recordingService(recordingStates);
    const factory = await createFactory(release, plugins, events, recordings);

    await expect(factory.create(factoryInput())).rejects.toThrow(fixture.message);

    expect(apply).not.toHaveBeenCalled();
    expect(recordingStates).toEqual(['active', 'finalizing', 'available']);
    expect(events).toEqual(['telemetry']);
  });
});

function replacementEngine(
  id: string,
  version = '1.0.0',
  apply: Parameters<typeof definePlugin>[1] = () => undefined,
) {
  return definePlugin(
    {
      id,
      version,
      contractVersion: 1,
      scope: 'session',
      requires: ['ovo.behavior'],
      provides: [STREAMING_VOICE_SERVICE_KEYS.sessionEngine],
      configSchema: {
        type: 'object',
        properties: {
          language: { type: 'string' },
          inputEnabled: { type: 'boolean' },
          initialInput: { type: 'string' },
          initialVariables: { type: 'object' },
        },
        additionalProperties: false,
      },
      secretFields: [],
    },
    apply,
  );
}

function releaseWithPins(recording: boolean, enginePins: ReleaseRecord['plugins']): ReleaseRecord {
  const agent = AgentConfig.parse({
    name: 'Engine conformance',
    mode: 'announcement',
    message: 'Welcome from the unchanged behavior',
    recording,
  });
  const behavior = createSessionPluginCatalog({
    config: agent,
    workspaceId: 'workspace-a',
    bindings: {},
    mcpConnections: [],
    output: { kind: 'simulation' },
  })[0]!;
  return {
    id: 'release-a',
    workspaceId: 'workspace-a',
    agentId: 'agent-a',
    draftVersion: 1,
    config: agent,
    plugins: [pin(behavior), ...enginePins],
    providerBindings: {
      tts: binding('tts', 'openai', { model: 'gpt-4o-mini-tts', voice: 'alloy' }),
    },
    mcpTools: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'operator-a',
  };
}

async function createFactory(
  release: ReleaseRecord,
  plugins: PluginDefinition[],
  events: string[],
  recordings?: LiveRecordingService,
) {
  const distribution = await loadDistribution({
    role: 'worker',
    profile: 'compose',
    env: {
      DATABASE_URL: 'postgres://unused:unused@127.0.0.1/unused',
      OVO_QUEUE_URL: 'http://127.0.0.1/unused',
      AWS_REGION: 'us-east-1',
    },
  });
  const parent = await compose([], []);
  return new ProductionVoiceSessionFactory(
    {
      getRelease: async () => release,
      getCall: async () => ({
        id: 'call-a',
        workspaceId: 'workspace-a',
        releaseId: release.id,
        kind: 'live',
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        completedAt: null,
      }),
      operationStore: {},
    } as never,
    { forAgent: () => ({ resolve: vi.fn() }) } as never,
    {
      createSession: async () => ({
        audit: vi.fn(),
        providerUsage: vi.fn(),
        inferenceUsage: vi.fn(),
        transcript: vi.fn(),
        startStage: vi.fn(),
        attachScheduler: vi.fn(),
        withOperationStore: (store: unknown) => store,
        close: async () => {
          events.push('telemetry');
        },
      }),
    } as never,
    undefined,
    undefined,
    { plugins, nativeHandlers: {} },
    recordings,
    30,
    undefined,
    {
      distribution,
      parent,
      carriers: {
        forJob: async () => ({
          carrier: {
            carrierId: 'twilio',
            capabilities: {
              media: {
                formats: [MULAW_8K],
                playbackEvidence: 'carrier-played',
                clearFlushesMarkers: true,
              },
            },
          },
        }),
      } as never,
    },
  );
}

function factoryInput() {
  return {
    job: {
      id: 'job-a',
      workspaceId: 'workspace-a',
      payload: { releaseId: 'release-a', callId: 'call-a' },
    } as never,
    route: { sessionId: 'session-a', generation: 1 } as never,
    media: media() as never,
  };
}

function media() {
  const unsubscribe = () => undefined;
  return {
    sessionId: 'media-a',
    codec: 'audio/x-mulaw',
    sampleRate: 8000,
    bufferedBytes: 0,
    sendAudio: vi.fn(async () => undefined),
    sendMark: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    onAudio: vi.fn(() => unsubscribe),
    onMark: vi.fn(() => unsubscribe),
    onDtmf: vi.fn(() => unsubscribe),
    onClose: vi.fn(() => unsubscribe),
  };
}

function recordingService(states: string[]) {
  return new LiveRecordingService(
    {
      create: vi.fn(),
      setState: vi.fn(async (_id, state) => {
        states.push(state);
      }),
    } as never,
    {} as never,
    () => Date.parse('2026-01-01T00:00:00.000Z'),
  );
}

function pin(plugin: PluginDefinition) {
  return { id: plugin.manifest.id, version: plugin.manifest.version };
}

function binding(id: string, provider: string, config: Record<string, unknown>) {
  return {
    id: `binding-${id}`,
    workspaceId: 'workspace-a',
    label: id,
    provider,
    environment: 'test',
    credentialId: `credential-${id}`,
    config,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}
