import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Cap, MULAW_8K } from '@winsendotai/ovo-contracts';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { describe, expect, it } from 'vitest';
import { buildManagementApi } from '../src/server.ts';

const inference = definePlugin(
  {
    id: '@fixture/inference',
    version: '1.0.0',
    contractVersion: 2,
    scope: 'session',
    kind: 'llm',
    provider: 'fixture',
    provides: [`${Cap.inference}@2`],
    requires: [],
    configSchema: { type: 'object' },
    secretFields: [],
    capabilities: { tools: false, streaming: false },
    meters: [
      { key: 'fixture.inference.input_tokens', unit: 'input_tokens', label: 'Input', role: 'llm' },
    ],
    runtime: { egressHosts: [], modelLicences: [] },
    conformance: ['llm@1'],
  },
  () => undefined,
);
const speech = definePlugin(
  {
    id: '@fixture/speech',
    version: '1.0.0',
    contractVersion: 1,
    scope: 'session',
    provides: [Cap.speech],
    requires: [],
    configSchema: { type: 'object' },
    secretFields: [],
  },
  () => undefined,
);

function engine(requires: string[]) {
  return definePlugin(
    {
      id: '@fixture/engine',
      version: '1.0.0',
      contractVersion: 2,
      scope: 'session',
      kind: 'engine',
      provider: 'fixture',
      provides: [`${Cap.engine}@2`],
      requires,
      companions: { [Cap.speech]: speech.manifest.id },
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
    () => undefined,
  );
}

describe('selection-model release publication', () => {
  it.each([
    ['context', [Cap.behavior, Cap.media], 201],
    ['agent', [Cap.behavior, Cap.media], 201],
    ['context', [Cap.behavior, 'missing.selected-port'], 422],
  ] as const)(
    'publishes or blocks a %s selection graph with status %s',
    async (mode, requires, status) => {
      const directory = await mkdtemp('/var/tmp/ovo-selection-release-');
      const selectedEngine = engine([...requires]);
      const { app, composition } = await buildManagementApi({
        databaseFile: join(directory, 'store.sqlite'),
        secretsMasterKey: Buffer.alloc(32, 7).toString('base64'),
        sessionSecret: 'fixture-session-secret',
        requireTlsForSecrets: false,
        pluginCatalog: [selectedEngine, inference, speech],
        identities: [
          {
            id: 'operator',
            label: 'Operator',
            token: 'fixture-token',
            defaultWorkspaceId: 'local',
            workspaces: { local: 'admin' },
          },
        ],
      });
      const headers = { authorization: 'Bearer fixture-token' };
      try {
        const agent = await app.inject({
          method: 'POST',
          url: '/v1/agents',
          headers,
          payload: {
            config: {
              name: 'Selected inference',
              mode,
              voice: {
                engine: { plugin: selectedEngine.manifest.id, config: {} },
                llm: { plugin: inference.manifest.id, binding: 'env', config: {} },
              },
            },
          },
        });
        expect(agent.statusCode, agent.body).toBe(201);
        const release = await app.inject({
          method: 'POST',
          url: `/v1/agents/${agent.json().id}/releases`,
          headers,
          payload: {},
        });
        expect(release.statusCode, release.body).toBe(status);
        if (status === 201) {
          expect(release.json().selections.llm).toMatchObject({
            pluginId: inference.manifest.id,
            bindingId: 'env',
          });
        } else {
          expect(release.json().blockers[0].message).toContain('missing.selected-port');
          expect(release.json().blockers[0].code).toBe('plugin_unavailable');
        }
        const readiness = await app.inject({
          method: 'GET',
          url: `/v1/agents/${agent.json().id}/readiness`,
          headers,
        });
        expect(readiness.statusCode).toBe(200);
        expect(readiness.json().releaseReady).toBe(status === 201);
      } finally {
        await composition.dispose();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
