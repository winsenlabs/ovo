import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Cap, type CarrierControlFactory, type CarrierIngress } from '@winsendotai/ovo-contracts';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';
import { definePlugin } from '@winsendotai/ovo-runtime';
import {
  fixtureCarrierCapabilities,
  fixtureCarrierIngress,
} from '../../../packages/conformance/src/drivers/fixture-carrier.ts';
import { buildManagementApi } from '../src/server.ts';
import {
  catalog as compatCatalog,
  carrier as compatCarrier,
} from '../../../packages/session-host/tests/compat-support.ts';
import type { PluginDefinition } from '@winsendotai/ovo-runtime';
import { selectedSpeechFixture, selectedSpeechVoice } from './selected-speech-fixture.ts';

const directories: string[] = [];
afterEach(() =>
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })),
);

const capabilities = { ...fixtureCarrierCapabilities(), carrierId: 'twilio' };
const ingress = definePlugin(
  {
    id: '@winsendotai/ovo-carrier-twilio',
    version: '0.1.0',
    contractVersion: 2,
    scope: 'process',
    kind: 'carrier',
    provider: 'twilio',
    provides: [Cap.carrierControl, Cap.carrierIngress],
    requires: [],
    configSchema: { type: 'object' },
    secretFields: [],
    bindingSchema: {
      type: 'object',
      required: ['accountSid'],
      properties: { accountSid: { type: 'string' } },
    },
    capabilities,
    meters: [
      {
        key: 'twilio.carrier.audio_seconds',
        unit: 'audio_seconds',
        label: 'Audio',
        role: 'carrier',
      },
    ],
    runtime: { egressHosts: [], modelLicences: [] },
    conformance: ['carrier@1'],
  },
  (ctx) => {
    ctx.provide(Cap.carrierControl, {
      capabilities,
      create: () => {
        throw new Error('not used');
      },
    } satisfies CarrierControlFactory);
    ctx.provide(Cap.carrierIngress, {
      ...fixtureCarrierIngress(),
      capabilities,
      carrierId: 'twilio',
      operatorUrls: [
        { purpose: 'inbound', label: 'Inbound', help: 'Paste into the carrier console' },
        { purpose: 'media', label: 'Media', help: 'Issued by the host' },
      ],
    } satisfies CarrierIngress);
  },
);

async function api(withUrls = true, extraCatalog: PluginDefinition[] = []) {
  const directory = mkdtempSync(join(tmpdir(), 'ovo-f4-api-'));
  directories.push(directory);
  return buildManagementApi({
    databaseFile: join(directory, 'control.sqlite'),
    secretsMasterKey: Buffer.alloc(32, 4).toString('base64'),
    sessionSecret: 'test-session-secret',
    identities: [
      {
        id: 'admin',
        label: 'Admin',
        token: 'admin-token',
        defaultWorkspaceId: 'w',
        workspaces: { w: 'admin' },
      },
    ],
    pluginCatalog: [ingress, selectedSpeechFixture, ...extraCatalog],
    carrierPublicBaseUrl: withUrls ? 'https://carrier.example.test' : '',
    inboundRouteSecret: withUrls ? 'a'.repeat(32) : '',
  });
}

const headers = { authorization: 'Bearer admin-token' };
const announcementWithTts = {
  name: 'Notice',
  mode: 'announcement',
  message: 'Hello',
  voice: selectedSpeechVoice,
};

describe('F4 API catalog and release wiring', () => {
  it('projects plugins without secrets and gives structured compatibility issues', async () => {
    const { app, composition } = await api();
    try {
      const secret = await app.inject({
        method: 'POST',
        url: '/v1/credentials',
        headers,
        payload: {
          label: 'Catalog sentinel',
          provider: 'twilio',
          type: 'api-key',
          environment: 'test',
          value: 'catalog-secret-sentinel-6479',
        },
      });
      expect(secret.statusCode).toBe(201);
      const listed = await app.inject({ method: 'GET', url: '/v1/plugins?kind=carrier', headers });
      expect(listed.statusCode).toBe(200);
      expect(
        listed.json().plugins.some((plugin: { provider?: string }) => plugin.provider === 'twilio'),
      ).toBe(true);
      expect(listed.body).not.toContain('catalog-secret-sentinel-6479');
      const compat = await app.inject({
        method: 'POST',
        url: '/v1/plugins/compat',
        headers,
        payload: {
          mode: 'announcement',
          language: 'en-IN',
          tools: [],
        },
      });
      expect(compat.statusCode).toBe(200);
      expect(compat.json()).toContainEqual(
        expect.objectContaining({ code: 'meter_uncovered', stage: 'live' }),
      );
    } finally {
      await composition.dispose();
    }
  });

  it('infers a unique binding plugin, validates its schema, and renders signed host URLs', async () => {
    const { app, composition } = await api();
    try {
      const secret = await app.inject({
        method: 'POST',
        url: '/v1/credentials',
        headers,
        payload: {
          label: 'Twilio',
          provider: 'twilio',
          type: 'api-key',
          environment: 'test',
          value: 'do-not-return',
        },
      });
      expect(secret.statusCode).toBe(201);
      const body = {
        label: 'Carrier',
        provider: 'twilio',
        environment: 'test',
        credentialId: secret.json().id,
      };
      const invalid = await app.inject({
        method: 'POST',
        url: '/v1/provider-bindings',
        headers,
        payload: { ...body, config: {} },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error.code).toBe('binding_schema_invalid');
      const created = await app.inject({
        method: 'POST',
        url: '/v1/provider-bindings',
        headers,
        payload: { ...body, config: { accountSid: 'AC123' } },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().pluginId).toBe('@winsendotai/ovo-carrier-twilio');
      const urls = await app.inject({
        method: 'GET',
        url: `/v1/provider-bindings/${created.json().id}/carrier-urls`,
        headers,
      });
      expect(urls.statusCode).toBe(200);
      expect(urls.json().items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            purpose: 'inbound',
            url: expect.stringMatching(
              /^https:\/\/carrier\.example\.test\/carriers\/twilio\/[^/]+\/inbound\?t=[a-f0-9]{64}$/,
            ),
          }),
          expect.objectContaining({
            purpose: 'media',
            url: expect.stringMatching(
              /^wss:\/\/carrier\.example\.test\/carriers\/twilio\/[^/]+\/media$/,
            ),
          }),
        ]),
      );
      expect(urls.body).not.toContain('do-not-return');
    } finally {
      await composition.dispose();
    }
  });

  it('persists selections and rejects unknown plugins as release blockers', async () => {
    const { app, composition } = await api();
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/agents',
        headers,
        payload: { config: announcementWithTts },
      });
      expect(created.statusCode).toBe(201);
      const url = `/v1/agents/${created.json().id}/releases`;
      const bad = await app.inject({
        method: 'POST',
        url,
        headers,
        payload: { pluginIds: ['not-installed'] },
      });
      expect(bad.statusCode).toBe(422);
      expect(bad.json().blockers).toContainEqual(
        expect.objectContaining({ code: 'plugin_not_installed', stage: 'release' }),
      );
      const released = await app.inject({ method: 'POST', url, headers, payload: {} });
      expect(released.statusCode).toBe(201);
      expect(released.json().selections.engine.pluginId).toBe(
        '@winsendotai/ovo-plugin-voice-session-engine',
      );
    } finally {
      await composition.dispose();
    }
  });

  it('reports immutable release pin drift and legacy unpinned releases in readiness', async () => {
    const { app, composition } = await api();
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/agents',
        headers,
        payload: { config: announcementWithTts },
      });
      const agentId = created.json().id as string;
      const released = await app.inject({
        method: 'POST',
        url: `/v1/agents/${agentId}/releases`,
        headers,
        payload: {},
      });
      expect(released.statusCode).toBe(201);
      const store = composition.ctx.get(Cap.controlStore) as ControlStore;
      const agent = (await store.getAgent('w', agentId))!;
      const snapshot = released.json();
      const driftAgent = await store.updateAgent('w', agentId, agent.draftVersion, agent.config);
      await store.createRelease({
        workspaceId: 'w',
        agent: driftAgent,
        plugins: snapshot.plugins,
        selections: {
          ...snapshot.selections,
          engine: { ...snapshot.selections.engine, version: '99.0.0' },
        },
        createdBy: 'admin',
      });
      const drift = await app.inject({
        method: 'GET',
        url: `/v1/agents/${agentId}/readiness`,
        headers,
      });
      expect(drift.json().details).toContainEqual(
        expect.objectContaining({ code: 'plugin_version_not_installed', stage: 'live' }),
      );
      expect(drift.json().liveReady).toBe(false);
      const legacyAgent = await store.updateAgent(
        'w',
        agentId,
        driftAgent.draftVersion,
        driftAgent.config,
      );
      await store.createRelease({
        workspaceId: 'w',
        agent: legacyAgent,
        plugins: snapshot.plugins,
        selections: {},
        createdBy: 'admin',
      });
      const legacy = await app.inject({
        method: 'GET',
        url: `/v1/agents/${agentId}/readiness`,
        headers,
      });
      expect(legacy.json().details).toContainEqual(
        expect.objectContaining({ code: 'legacy_release_unpinned', severity: 'warning' }),
      );
    } finally {
      await composition.dispose();
    }
  });

  it('returns structured live readiness details and a clear carrier URL configuration error', async () => {
    const { app, composition } = await api(false);
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/agents',
        headers,
        payload: { config: announcementWithTts },
      });
      expect(created.statusCode).toBe(201);
      const ready = await app.inject({
        method: 'GET',
        url: `/v1/agents/${created.json().id}/readiness`,
        headers,
      });
      expect(ready.statusCode).toBe(200);
      expect(ready.json().blockers).toEqual([]);
      expect(ready.json().details).toContainEqual(
        expect.objectContaining({
          stage: 'live',
          severity: 'error',
          field: 'costPolicy',
        }),
      );
      const credential = await app.inject({
        method: 'POST',
        url: '/v1/credentials',
        headers,
        payload: {
          label: 'Twilio',
          provider: 'twilio',
          type: 'api-key',
          environment: 'test',
          value: 'do-not-return',
        },
      });
      const binding = await app.inject({
        method: 'POST',
        url: '/v1/provider-bindings',
        headers,
        payload: {
          label: 'Carrier',
          provider: 'twilio',
          environment: 'test',
          credentialId: credential.json().id,
          config: { accountSid: 'AC123' },
        },
      });
      expect(binding.statusCode).toBe(201);
      const urls = await app.inject({
        method: 'GET',
        url: `/v1/provider-bindings/${binding.json().id}/carrier-urls`,
        headers,
      });
      expect(urls.statusCode).toBe(409);
      expect(urls.json().error).toMatchObject({ code: 'carrier_urls_unavailable' });
    } finally {
      await composition.dispose();
    }
  });

  it('reports weak carrier playback for a confirmed write and accepts the explicit acknowledgement', async () => {
    const weak = compatCatalog({
      carrier: {
        capabilities: {
          ...compatCarrier,
          media: { ...compatCarrier.media, playbackEvidence: 'none' },
        },
      },
    });
    const { app, composition } = await api(true, weak);
    try {
      const preview = (acknowledgements: string[]) =>
        app.inject({
          method: 'POST',
          url: '/v1/plugins/compat',
          headers,
          payload: {
            mode: 'announcement',
            language: 'en-IN',
            voice: {
              engine: { plugin: 'engine', config: {} },
              carrier: { plugin: 'carrier', config: {} },
              tts: { plugin: 'tts', config: {} },
              acknowledgements,
            },
            tools: [
              {
                id: 'write',
                description: 'write',
                connector: 'native',
                inputSchema: {},
                effect: 'write',
                confirmation: true,
              },
            ],
          },
        });
      const blocked = await preview([]);
      expect(blocked.statusCode).toBe(200);
      expect(blocked.json()).toContainEqual(
        expect.objectContaining({
          code: 'playback_evidence_insufficient',
          stage: 'live',
        }),
      );
      const allowed = await preview(['weak-playback-evidence']);
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json()).not.toContainEqual(
        expect.objectContaining({
          code: 'playback_evidence_insufficient',
        }),
      );
    } finally {
      await composition.dispose();
    }
  });
});
