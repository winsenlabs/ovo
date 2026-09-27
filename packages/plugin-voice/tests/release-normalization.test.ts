import { describe, expect, it } from 'vitest';
import type { AgentConfig } from '@winsendotai/ovo-contracts';
import { buildManagementApi } from '../../../apps/api/src/server.ts';
import {
  selectedSpeechFixture,
  selectedSpeechVoice,
} from '../../../apps/api/tests/selected-speech-fixture.ts';
import { MARKDOWN_FILTER_ID } from '../src/speech/text-filters.ts';
import { STREAMING_VOICE_PLUGIN_IDS } from '../src/production-plugins.ts';

describe('native default filter release publication', () => {
  it('keeps the source draft immutable while publishing the installed default filter', async () => {
    let source: { config: AgentConfig } | undefined;
    let snapshot: { config: AgentConfig } | undefined;
    const { app, composition } = await buildManagementApi({
      databaseFile: ':memory:',
      secretsMasterKey: Buffer.alloc(32, 7).toString('base64'),
      sessionSecret: 'native-filter-release-test',
      pluginCatalog: [selectedSpeechFixture],
      createReleasePlugins: ({ agent }) => {
        source = agent;
        snapshot = structuredClone(agent);
        return [];
      },
      identities: [
        {
          id: 'operator',
          label: 'Operator',
          token: 'native-filter-release-token',
          defaultWorkspaceId: 'local',
          workspaces: { local: 'admin' },
        },
      ],
    });
    const headers = { authorization: 'Bearer native-filter-release-token' };
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/agents',
        headers,
        payload: {
          config: {
            name: 'Native default markdown filter',
            mode: 'announcement',
            message: '**Welcome**',
            voice: { ...selectedSpeechVoice, textFilters: [] },
          },
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const published = await app.inject({
        method: 'POST',
        url: `/v1/agents/${created.json().id}/releases`,
        headers,
        payload: {},
      });
      expect(snapshot?.config.voice?.textFilters).toEqual([]);
      expect(
        source?.config,
        'release normalization must not mutate the draft supplied by storage',
      ).toEqual(snapshot?.config);
      expect(published.statusCode, published.body).toBe(201);
      expect(published.json().selections.engine.pluginId).toBe(
        STREAMING_VOICE_PLUGIN_IDS.sessionEngine,
      );
      expect(published.json().selections['textFilter:0'].pluginId).toBe(MARKDOWN_FILTER_ID);
      const persisted = await app.inject({
        method: 'GET',
        url: `/v1/agents/${created.json().id}`,
        headers,
      });
      expect(persisted.statusCode, persisted.body).toBe(200);
      expect(persisted.json().config).toEqual(snapshot?.config);
    } finally {
      await composition.dispose();
    }
  });
});
