import { AgentConfig, Cap, type MediaDuplex } from '@winsendotai/ovo-contracts';
import { loadDistribution } from '@winsendotai/ovo-distribution';
import { PluginRegistry, definePlugin } from '@winsendotai/ovo-runtime';
import { describe, expect, it } from 'vitest';
import { selectSessionGraph } from '@winsendotai/ovo-session-host';

describe('weak playback acknowledgement wiring', () => {
  it('configures the native output companion to accept carrier-processed evidence', async () => {
    const distribution = await loadDistribution({
      role: 'worker',
      profile: 'compose',
      env: {
        DATABASE_URL: 'postgres://unused:unused@127.0.0.1/unused',
        OVO_QUEUE_URL: 'http://127.0.0.1/unused',
        AWS_REGION: 'us-east-1',
      },
    });
    const usage = definePlugin(
      {
        id: '@fixture/usage',
        version: '1.0.0',
        contractVersion: 1,
        scope: 'session',
        provides: [Cap.usage],
        requires: [],
        configSchema: { type: 'object' },
        secretFields: [],
      },
      () => undefined,
    );
    const rows = selectSessionGraph({
      release: {
        id: 'release-1',
        workspaceId: 'workspace-1',
        config: AgentConfig.parse({
          name: 'Weak playback',
          mode: 'announcement',
          message: 'Hello',
          voice: { acknowledgements: ['weak-playback-evidence'] },
        }),
        plugins: [],
        selections: {
          engine: {
            pluginId: '@winsendotai/ovo-plugin-voice-session-engine',
            version: '0.1.0',
            config: {},
          },
          tts: {
            pluginId: '@winsendotai/ovo-provider-openai-tts',
            version: '0.1.0',
            config: {},
          },
        },
      },
      registry: new PluginRegistry(distribution.catalog),
      hostServices: [usage],
      parent: [],
      media: { sessionId: 'session-1' } as MediaDuplex,
      installedExtensions: { plugins: [], nativeHandlers: {} },
      defaults: distribution.defaults,
    });
    expect(
      rows.rows.find((row) => row.id === '@winsendotai/ovo-plugin-speech-output-media')?.config,
    ).toEqual({ allowWeakEvidence: true });
  });
});
