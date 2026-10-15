import { describe, expect, it } from 'vitest';
import { Cap } from '@winsendotai/ovo-contracts';
import { fakeMediaRoom } from '@winsendotai/ovo-conformance';
import { compose, configError, definePlugin } from '@winsendotai/ovo-runtime';
import { FIRST_PARTY, type CatalogEntry } from '../src/catalog.ts';
import { loadDistribution } from '../src/load.ts';
import { DEFAULT_ROOM_URL, ROOM_PLUGIN_ID, roomRows } from '../src/profiles/rooms.ts';

const workerEnv = {
  DATABASE_URL: 'postgres://local',
  OVO_QUEUE_URL: 'http://localhost/queue',
  AWS_REGION: 'us-east-1',
  OVO_SECRETS_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
};
const roomEnv = {
  OVO_LIVEKIT_ENABLED: 'true',
  OVO_LIVEKIT_API_KEY: 'lk-key',
  OVO_LIVEKIT_API_SECRET: 'lk-secret-lk-secret-lk-secret-0123',
};

/**
 * Stands in for the room plugin the media lane delivers: the same id, the capability it provides,
 * and a config schema for the row the profile builds.
 */
const standIn = definePlugin(
  {
    id: ROOM_PLUGIN_ID,
    version: '1.0.0',
    contractVersion: 2,
    kind: 'infra',
    scope: 'process',
    requires: [],
    provides: [Cap.mediaRoom],
    configSchema: {
      type: 'object',
      required: ['url', 'apiKey', 'apiSecret', 'tokenTtlSeconds'],
      additionalProperties: false,
      properties: {
        url: { type: 'string' },
        publicUrl: { type: 'string' },
        apiKey: { type: 'string' },
        apiSecret: { type: 'string' },
        previousApiKey: { type: 'string' },
        previousApiSecret: { type: 'string' },
        tokenTtlSeconds: { type: 'integer' },
      },
    },
    secretFields: ['apiSecret', 'previousApiSecret'],
  },
  (ctx) => void ctx.provide(Cap.mediaRoom, fakeMediaRoom()),
);
const withStandIn: readonly CatalogEntry[] = [
  ...FIRST_PARTY.filter((entry) => entry.package !== ROOM_PLUGIN_ID),
  { package: ROOM_PLUGIN_ID, roles: ['api', 'worker'], load: async () => ({ plugins: [standIn] }) },
];

describe('room server rows (managed human queues)', () => {
  it('has no row, and so no capability, unless OVO_LIVEKIT_ENABLED is exactly true', () => {
    for (const value of [undefined, '', 'false', 'TRUE', '1', 'yes', ' true'])
      expect(roomRows({ ...roomEnv, OVO_LIVEKIT_ENABLED: value }), String(value)).toEqual([]);
    expect(roomRows({})).toEqual([]);
  });

  it('builds the plugin row from OVO_LIVEKIT_*, with the internal url default', () => {
    expect(roomRows(roomEnv)).toEqual([
      {
        id: ROOM_PLUGIN_ID,
        config: {
          url: DEFAULT_ROOM_URL,
          apiKey: 'lk-key',
          apiSecret: 'lk-secret-lk-secret-lk-secret-0123',
          tokenTtlSeconds: 120,
        },
      },
    ]);
    expect(
      roomRows({
        ...roomEnv,
        OVO_LIVEKIT_URL: 'ws://livekit:7880',
        OVO_LIVEKIT_PUBLIC_URL: 'wss://rooms.example.com',
        OVO_LIVEKIT_TOKEN_TTL_SECONDS: '90',
        OVO_LIVEKIT_API_KEY_PREVIOUS: 'old-key',
        OVO_LIVEKIT_API_SECRET_PREVIOUS: 'old-secret',
      })[0]!.config,
    ).toEqual({
      url: 'ws://livekit:7880',
      publicUrl: 'wss://rooms.example.com',
      apiKey: 'lk-key',
      apiSecret: 'lk-secret-lk-secret-lk-secret-0123',
      previousApiKey: 'old-key',
      previousApiSecret: 'old-secret',
      tokenTtlSeconds: 90,
    });
  });

  it('reads the empty strings Compose renders for unset optional variables as their defaults', () => {
    expect(
      roomRows({
        ...roomEnv,
        OVO_LIVEKIT_URL: '',
        OVO_LIVEKIT_PUBLIC_URL: '',
        OVO_LIVEKIT_TOKEN_TTL_SECONDS: '',
        OVO_LIVEKIT_API_KEY_PREVIOUS: '',
        OVO_LIVEKIT_API_SECRET_PREVIOUS: '',
      })[0]!.config,
    ).toEqual(roomRows(roomEnv)[0]!.config);
  });

  it('refuses a half-configured room: missing keys, bad urls, bad ttl, half a previous pair', () => {
    const { OVO_LIVEKIT_API_KEY: _key, ...noKey } = roomEnv;
    const { OVO_LIVEKIT_API_SECRET: _secret, ...noSecret } = roomEnv;
    expect(() => roomRows(noKey)).toThrow(/OVO_LIVEKIT_API_KEY/);
    expect(() => roomRows(noSecret)).toThrow(/OVO_LIVEKIT_API_SECRET/);
    expect(() => roomRows({ ...roomEnv, OVO_LIVEKIT_API_KEY: '  ' })).toThrow(
      /OVO_LIVEKIT_API_KEY/,
    );
    expect(() => roomRows({ ...roomEnv, OVO_LIVEKIT_URL: 'http://livekit:7880' })).toThrow(
      /ws:\/\//,
    );
    expect(() =>
      roomRows({ ...roomEnv, OVO_LIVEKIT_PUBLIC_URL: 'https://rooms.example.com' }),
    ).toThrow(/ws:\/\//);
    for (const ttl of ['29', '601', '1.5', 'abc'])
      expect(() => roomRows({ ...roomEnv, OVO_LIVEKIT_TOKEN_TTL_SECONDS: ttl }), ttl).toThrow(
        /TTL_SECONDS/,
      );
    expect(() => roomRows({ ...roomEnv, OVO_LIVEKIT_API_KEY_PREVIOUS: 'old' })).toThrow(
      /go together/,
    );
    expect(() => roomRows({ ...roomEnv, OVO_LIVEKIT_API_SECRET_PREVIOUS: 'old' })).toThrow(
      /go together/,
    );
  });

  it('leaves the room plugin out of every role while the flag is off', async () => {
    for (const role of ['api', 'worker'] as const) {
      const loaded = await loadDistribution({
        role,
        profile: 'compose',
        env: role === 'api' ? {} : workerEnv,
        firstParty: withStandIn,
      });
      expect(
        loaded.catalog.some((p) => p.manifest.id === ROOM_PLUGIN_ID),
        role,
      ).toBe(false);
      expect(
        loaded.processRows.some((row) => row.id === ROOM_PLUGIN_ID),
        role,
      ).toBe(false);
    }
  });

  it('adds the plugin and its row for the api and worker only, with the flag on', async () => {
    for (const role of ['api', 'worker'] as const) {
      const loaded = await loadDistribution({
        role,
        profile: 'compose',
        env: { ...(role === 'worker' ? workerEnv : {}), ...roomEnv },
        firstParty: withStandIn,
      });
      const row = loaded.processRows.find((r) => r.id === ROOM_PLUGIN_ID)!;
      expect(row.config).toMatchObject({ url: DEFAULT_ROOM_URL, apiKey: 'lk-key' });
      const definition = loaded.catalog.find((p) => p.manifest.id === ROOM_PLUGIN_ID)!;
      expect(configError(definition.manifest, row.config ?? {})).toBeUndefined();
    }
    // The gateway and the dispatcher never list the plugin, so the flag cannot reach them.
    for (const role of ['gateway', 'dispatcher'] as const)
      expect(
        FIRST_PARTY.find((e) => e.package === ROOM_PLUGIN_ID)?.roles.includes(role),
        role,
      ).toBe(false);
  });

  it('provides ovo.media-room when composed on, and nothing when off', async () => {
    const off = await loadDistribution({
      role: 'api',
      profile: 'compose',
      env: {},
      firstParty: withStandIn,
    });
    const offGraph = await compose(
      off.processRows.filter((row) => row.id === ROOM_PLUGIN_ID),
      off.catalog.filter((p) => p.manifest.id === ROOM_PLUGIN_ID),
      { scope: 'process' },
    );
    expect(offGraph.keys.has(Cap.mediaRoom)).toBe(false);
    await offGraph.dispose();
    const on = await loadDistribution({
      role: 'api',
      profile: 'compose',
      env: roomEnv,
      firstParty: withStandIn,
    });
    const graph = await compose(
      on.processRows.filter((row) => row.id === ROOM_PLUGIN_ID),
      on.catalog.filter((p) => p.manifest.id === ROOM_PLUGIN_ID),
      { scope: 'process' },
    );
    expect(graph.keys.has(Cap.mediaRoom)).toBe(true);
    expect((graph.get(Cap.mediaRoom) as { provider: string }).provider).toBe('fake-room');
    await graph.dispose();
  });

  it('fails loudly when the flag is on but the plugin package provides no room plugin yet', async () => {
    await expect(
      loadDistribution({ role: 'api', profile: 'compose', env: roomEnv }),
    ).rejects.toThrow(/not installed.*room-livekit/);
  });

  it('keeps the real catalog entry for api and worker only', () => {
    expect(FIRST_PARTY.find((e) => e.package === ROOM_PLUGIN_ID)?.roles).toEqual(['api', 'worker']);
  });
});
