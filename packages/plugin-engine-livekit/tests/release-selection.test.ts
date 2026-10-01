import { afterAll, beforeAll, expect, it } from 'vitest';
import { AgentConfig, Cap, type VoiceSessionEngine } from '@winsendotai/ovo-contracts';
import { compose, definePlugin, PluginRegistry, setGlibcProbe } from '@winsendotai/ovo-runtime';
import {
  createFakeCarrier,
  createScriptedTts,
  installEgressSentinel,
  realClock,
  type EgressSentinel,
} from '@winsendotai/ovo-conformance/drivers';
import { loadDistribution } from '../../distribution/src/load.ts';
import { selectSessionGraph } from '../../session-host/src/select-session-graph.ts';
import { STREAMING_VOICE_PLUGIN_IDS } from '../../plugin-voice/src/production-plugins.ts';
import { ENGINE_ID } from '../src/plugin.ts';

let sentinel: EgressSentinel;
beforeAll(() => {
  sentinel = installEgressSentinel({ allowLoopback: false });
  setGlibcProbe(() => 'test-host-native-binding');
});
afterAll(() => {
  try {
    expect(sentinel.attempts).toEqual([]);
  } finally {
    setGlibcProbe(undefined);
    sentinel.restore();
  }
});

it('runs the same release config through either real engine selected by release.selections', async () => {
  const distribution = await loadDistribution({
    role: 'api',
    profile: 'compose',
    env: {},
    log() {},
  });
  const registry = new PluginRegistry(distribution.catalog);
  const config = AgentConfig.parse({
    name: 'Greeting',
    mode: 'announcement',
    message: 'Hello {{customer}}.',
    variables: {
      type: 'object',
      properties: { customer: { type: 'string' } },
      required: ['customer'],
    },
  });
  for (const id of [STREAMING_VOICE_PLUGIN_IDS.sessionEngine, ENGINE_ID]) {
    const carrier = createFakeCarrier();
    const tts = createScriptedTts();
    const host = definePlugin(
      {
        id: 'e3-release-selection-host',
        version: '0.1.0',
        contractVersion: 2,
        kind: 'host',
        scope: 'session',
        provides: [Cap.tts, Cap.usage, Cap.clock, Cap.transcripts],
        requires: [],
        configSchema: { type: 'object' },
        secretFields: [],
      },
      (ctx) => {
        ctx.provide(Cap.tts, tts);
        ctx.provide(Cap.usage, () => {});
        ctx.provide(Cap.clock, realClock);
        ctx.provide(Cap.transcripts, () => {});
      },
    );
    const selected = selectSessionGraph({
      release: {
        id: 'same-release',
        workspaceId: 'workspace',
        config,
        plugins: [],
        selections: { engine: { pluginId: id, version: '0.1.0', config: {} } },
      },
      registry,
      hostServices: [host],
      parent: [],
      media: carrier.duplex,
      installedExtensions: { plugins: [], nativeHandlers: {} },
      sessionVariables: { customer: 'Asha' },
    });
    expect(selected.resolved.engine.id).toBe(id);
    const graph = await compose(selected.rows, selected.catalog, { scope: 'session' });
    const engine = graph.get(Cap.engine) as VoiceSessionEngine;
    try {
      await engine.start();
      expect((await engine.ended).reason).toBe('behavior_completed');
      expect(tts.texts).toContain('Hello Asha.');
      expect(carrier.log.some((entry) => entry.type === 'audio')).toBe(true);
      expect(graph.violations).toEqual([]);
    } finally {
      await engine.dispose('drain');
      await graph.dispose();
    }
  }
}, 60000);
