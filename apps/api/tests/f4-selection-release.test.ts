import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { BEHAVIOR_PLUGIN_IDS } from '@winsendotai/ovo-behaviors';
import { Cap, MULAW_8K } from '@winsendotai/ovo-contracts';
import type { AgentDraft } from '@winsendotai/ovo-plugin-storage';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { describe, expect, it } from 'vitest';
import { validatePermittedGraph } from '../src/release-graph.ts';
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
const tts = definePlugin(
  {
    id: '@fixture/tts',
    version: '1.0.0',
    contractVersion: 2,
    scope: 'session',
    kind: 'tts',
    provider: 'fixture',
    provides: [`${Cap.tts}@2`],
    requires: [],
    optional: [],
    configSchema: { type: 'object' },
    secretFields: [],
    capabilities: {
      outputFormats: [MULAW_8K],
      languages: ['*'],
      interim: false,
      wordTimestamps: false,
      turnSignals: [],
      forceEndpoint: false,
    },
    meters: [{ key: 'fixture.tts.characters', unit: 'characters', label: 'Text', role: 'tts' }],
    runtime: { egressHosts: [], modelLicences: [] },
    conformance: ['tts@1'],
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
  it('admits a selected TTS dependency even when it is absent from release.plugins', () => {
    const behavior = definePlugin(
      {
        id: BEHAVIOR_PLUGIN_IDS.faq,
        version: '1.0.0',
        contractVersion: 1,
        scope: 'session',
        provides: [Cap.behavior],
        requires: [Cap.tts],
        configSchema: { type: 'object' },
        secretFields: [],
      },
      () => undefined,
    );
    const services = definePlugin(
      {
        id: '@fixture/services',
        version: '1.0.0',
        contractVersion: 1,
        scope: 'session',
        provides: [],
        requires: [],
        configSchema: { type: 'object' },
        secretFields: [],
      },
      () => undefined,
    );
    const agent = { config: { mode: 'faq', faq: [], providers: {} } } as unknown as AgentDraft;
    const graph = validatePermittedGraph(
      agent,
      [behavior],
      services,
      { tts: { pluginId: tts.manifest.id, version: tts.manifest.version, config: {} } },
      [behavior, tts],
    );
    expect(graph).toEqual(new Set([behavior.manifest.id, tts.manifest.id]));
  });

  it.each([
    ['context', [Cap.behavior, Cap.media], 201, true],
    ['agent', [Cap.behavior, Cap.media], 201, true],
    ['context', [Cap.behavior, 'missing.selected-port'], 422, true],
    ['context', [Cap.behavior, 'missing.default-port'], 422, false],
    ['agent', [Cap.behavior, Cap.tts], 201, false],
  ] as const)(
    'publishes or blocks a %s selection graph with status %s',
    async (mode, requires, status, explicitEngine) => {
      const directory = await mkdtemp('/var/tmp/ovo-selection-release-');
      const selectedEngine = engine([...requires]);
      const { app, composition } = await buildManagementApi({
        databaseFile: join(directory, 'store.sqlite'),
        secretsMasterKey: Buffer.alloc(32, 7).toString('base64'),
        sessionSecret: 'fixture-session-secret',
        requireTlsForSecrets: false,
        pluginCatalog: [selectedEngine, inference, speech, tts],
        distributionDefaults: { engine: selectedEngine.manifest.id },
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
                ...(explicitEngine
                  ? { engine: { plugin: selectedEngine.manifest.id, config: {} } }
                  : {}),
                llm: { plugin: inference.manifest.id, binding: 'env', config: {} },
                ...((requires as readonly string[]).includes(Cap.tts)
                  ? { tts: { plugin: tts.manifest.id, binding: 'env', config: {} } }
                  : {}),
              },
            },
          },
        });
        expect(agent.statusCode, agent.body).toBe(201);
        if ((requires as readonly string[]).includes('missing.default-port')) {
          const readinessBeforeRelease = await app.inject({
            method: 'GET',
            url: `/v1/agents/${agent.json().id}/readiness`,
            headers,
          });
          expect(readinessBeforeRelease.statusCode).toBe(200);
          expect(readinessBeforeRelease.json().releaseReady).toBe(false);
          expect(readinessBeforeRelease.json().blockers).toEqual(
            expect.arrayContaining([expect.stringContaining('missing.default-port')]),
          );
        }
        const release = await app.inject({
          method: 'POST',
          url: `/v1/agents/${agent.json().id}/releases`,
          headers,
          payload: {},
        });
        expect(release.statusCode, release.body).toBe(status);
        if (status === 201) {
          if ((requires as readonly string[]).includes(Cap.tts))
            expect(release.json().selections.tts.pluginId).toBe(tts.manifest.id);
          expect(release.json().selections.llm).toMatchObject({
            pluginId: inference.manifest.id,
            bindingId: 'env',
          });
        } else {
          expect(release.json().blockers[0].message).toContain(
            explicitEngine ? 'missing.selected-port' : 'missing.default-port',
          );
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
