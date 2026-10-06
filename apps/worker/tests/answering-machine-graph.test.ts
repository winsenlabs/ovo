import { AgentConfig, Cap, MULAW_8K, type MediaDuplex } from '@winsendotai/ovo-contracts';
import type { LoadedDistribution } from '@winsendotai/ovo-distribution';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import { compose, definePlugin } from '@winsendotai/ovo-runtime';
import { expect, it, vi } from 'vitest';
import { composeLiveSessionGraph } from '../src/session-graph-runtime.ts';

it('hands a v2 engine the answering-machine hold and the verdict channel', async () => {
  let seen: { config: Record<string, unknown>; media: MediaDuplex } | undefined;
  const llm = definePlugin(
    {
      id: 'fixture-llm',
      version: '1.0.0',
      contractVersion: 2,
      scope: 'session',
      kind: 'llm',
      provider: 'fixture',
      provides: [Cap.inference],
      requires: [],
      configSchema: { type: 'object' },
      secretFields: [],
      capabilities: { tools: true, streaming: false },
      meters: [{ key: 'fixture.llm', unit: 'input_tokens', label: 'Input', role: 'llm' }],
      runtime: { egressHosts: [], modelLicences: [] },
      conformance: ['llm@1'],
    },
    (ctx) => {
      ctx.provide(Cap.inference, { generate: async () => ({ kind: 'text', text: '' }) });
    },
  );
  const speech = definePlugin(
    {
      id: 'fixture-speech',
      version: '1.0.0',
      contractVersion: 1,
      scope: 'session',
      provides: [Cap.speech],
      requires: [],
      configSchema: { type: 'object' },
      secretFields: [],
    },
    (ctx) => {
      ctx.provide(Cap.speech, { speak: async () => undefined });
    },
  );
  const output = definePlugin(
    {
      id: 'fixture-output',
      version: '1.0.0',
      contractVersion: 1,
      scope: 'session',
      provides: [Cap.output],
      requires: [],
      configSchema: { type: 'object' },
      secretFields: [],
    },
    (ctx) => {
      ctx.provide(Cap.output, {
        play: async () => ({ state: 'completed', evidence: 'confirmed' }),
        interrupt: async () => undefined,
      });
    },
  );
  const engine = definePlugin(
    {
      id: 'fixture-engine',
      version: '1.0.0',
      contractVersion: 2,
      scope: 'session',
      kind: 'engine',
      provider: 'fixture',
      provides: [`${Cap.engine}@2`],
      requires: [Cap.behavior, Cap.media, Cap.output],
      companions: { [Cap.speech]: 'fixture-speech', [Cap.output]: 'fixture-output' },
      configSchema: { type: 'object' },
      secretFields: [],
      capabilities: {
        turnDetection: ['provider'],
        bargeIn: true,
        dtmf: true,
        confirmedPlayback: true,
        ownsProviders: false,
        formats: [MULAW_8K],
        consumesTurnDetector: false,
      },
      runtime: { egressHosts: [], modelLicences: [] },
      conformance: ['engine@1'],
    },
    (ctx, config) => {
      seen = { config, media: ctx.get(Cap.media) as MediaDuplex };
      ctx.provide(Cap.engine, {
        start: async () => undefined,
        dispose: async () => ({ reason: 'drain', outcome: 'failed' }),
        ended: new Promise(() => undefined),
        subscribe: () => () => undefined,
        ingressStats: {
          acceptedFrames: 0,
          acceptedBytes: 0,
          pendingFrames: 0,
          pendingBytes: 0,
          overflows: 0,
        },
      });
    },
  );
  const parent = await compose([], []);
  const release = {
    id: 'release-1',
    workspaceId: 'workspace-1',
    agentId: 'agent-1',
    config: AgentConfig.parse({ name: 'Greeter', mode: 'context' }),
    plugins: [],
    providerBindings: {},
    mcpTools: {},
    selections: {
      engine: { pluginId: 'fixture-engine', version: '1.0.0', config: {} },
      llm: { pluginId: 'fixture-llm', version: '1.0.0', config: {} },
    },
  } as unknown as ReleaseRecord;
  const verdicts = new Set<(value: 'human' | 'machine' | 'unknown') => void>();
  try {
    const graph = await composeLiveSessionGraph({
      graph: {
        distribution: {
          catalog: [llm, engine, speech, output],
          defaults: { engine: 'fixture-engine' },
        } as unknown as LoadedDistribution,
        parent,
      },
      release,
      routeSessionId: 'session-1',
      variables: {},
      media: {
        sessionId: 'session-1',
        bufferedBytes: 0,
        onAudio: () => () => undefined,
        onMark: () => () => undefined,
        onDtmf: () => () => undefined,
        onClose: () => () => undefined,
      } as never,
      operationStore: {} as never,
      secrets: {} as never,
      telemetry: { providerUsage: vi.fn(), audit: vi.fn(), startStage: vi.fn() } as never,
      extensions: { plugins: [], nativeHandlers: {} },
      carrierMedia: {
        carrierId: 'fixture',
        format: MULAW_8K,
        playbackEvidence: 'carrier-played',
        clearFlushesMarkers: true,
      },
      amd: { timeoutMs: 4000 },
      answeredBy: (listener) => {
        verdicts.add(listener);
        return () => verdicts.delete(listener);
      },
    });
    expect(seen!.config.session).toMatchObject({ amd: { timeoutMs: 4000 } });
    const heard = vi.fn();
    seen!.media.onAnsweredBy!(heard);
    for (const verdict of verdicts) verdict('machine');
    expect(heard).toHaveBeenCalledWith('machine');
    await graph.composition.dispose();
  } finally {
    await parent.dispose();
  }
});
