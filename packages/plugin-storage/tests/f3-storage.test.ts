import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import { deriveLegacySelections, NodeSqliteControlStore } from '../src/index.ts';

const config = (name: string, providers: Record<string, string> = {}) =>
  AgentConfig.parse({ name, mode: 'announcement', message: name, providers });

describe('F3 SQLite storage', () => {
  it('can explicitly clear nullable binding metadata', async () => {
    const store = new NodeSqliteControlStore(':memory:');
    try {
      await store.ensureWorkspace('w');
      const credential = await store.createCredential({
        workspaceId: 'w',
        label: 'test',
        provider: 'fixture',
        type: 'api-key',
        environment: 'test',
        backend: 'local',
        permittedAgentIds: [],
        createdBy: 'test',
        fingerprint: 'fingerprint',
        secret: {
          ciphertext: Buffer.from('x'),
          nonce: Buffer.alloc(12),
          authTag: Buffer.alloc(16),
          backendRef: null,
        },
      });
      const binding = await store.createProviderBinding({
        workspaceId: 'w',
        label: 'Binding',
        provider: 'fixture',
        environment: 'test',
        credentialId: credential.id,
        config: {},
        kind: 'tts',
        pluginId: 'plugin.fixture',
      });
      expect(binding).toMatchObject({ kind: 'tts', pluginId: 'plugin.fixture' });
      const changed = await store.updateProviderBinding('w', binding.id, {
        label: 'Binding',
        provider: 'different',
        environment: 'test',
        credentialId: credential.id,
        config: {},
      });
      expect(changed).toMatchObject({ provider: 'different', kind: null, pluginId: null });
      await store.updateProviderBinding('w', binding.id, {
        label: 'Binding',
        provider: 'fixture',
        environment: 'test',
        credentialId: credential.id,
        config: {},
        kind: 'tts',
        pluginId: 'plugin.fixture',
      });
      const cleared = await store.updateProviderBinding('w', binding.id, {
        label: 'Binding',
        provider: 'fixture',
        environment: 'test',
        credentialId: credential.id,
        config: {},
        kind: null,
        pluginId: null,
      });
      expect(cleared).toMatchObject({ kind: null, pluginId: null });
    } finally {
      await store.close();
    }
  });
  it('persists selections, reads newest first, and applies all call filters with keyset cursors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ovo-f3-storage-'));
    const filename = join(dir, 'control.sqlite');
    try {
      const store = new NodeSqliteControlStore(filename);
      await store.ensureWorkspace('w');
      const a = await store.createAgent('w', config('A'), 'a');
      const b = await store.createAgent('w', config('B'), 'b');
      const releaseA = await store.createRelease({
        workspaceId: 'w',
        agent: a,
        plugins: [],
        createdBy: 'test',
        id: 'ra',
        selections: {
          engine: { pluginId: 'engine-a', version: '1.0.0', config: {} },
          carrier: { pluginId: 'carrier-a', version: '1.0.0', config: {} },
        },
      });
      const releaseB = await store.createRelease({
        workspaceId: 'w',
        agent: b,
        plugins: [],
        createdBy: 'test',
        id: 'rb',
        selections: {
          engine: { pluginId: 'engine-b', version: '1.0.0', config: {} },
          carrier: { pluginId: 'carrier-b', version: '1.0.0', config: {} },
        },
      });
      expect((await store.getRelease('w', 'ra'))?.selections).toEqual(releaseA.selections);
      await store.createCall({
        workspaceId: 'w',
        releaseId: releaseA.id,
        kind: 'live',
        status: 'done',
        id: '1',
      });
      await store.createCall({
        workspaceId: 'w',
        releaseId: releaseA.id,
        kind: 'test',
        status: 'pending',
        id: '2',
      });
      await store.createCall({
        workspaceId: 'w',
        releaseId: releaseB.id,
        kind: 'simulation',
        status: 'done',
        id: '3',
      });
      const db = new DatabaseSync(filename);
      db.exec("UPDATE calls SET created_at='2025-01-01T00:00:00.000Z'");
      expect((await store.listCalls('w')).items.map((item) => item.id)).toEqual(['3', '2', '1']);
      expect(
        (await store.listCalls('w', 10, undefined, { order: 'asc' })).items.map((item) => item.id),
      ).toEqual(['1', '2', '3']);
      const first = await store.listCalls('w', 1);
      const second = await store.listCalls('w', 1, first.nextCursor!);
      expect([first.items[0]!.id, second.items[0]!.id]).toEqual(['3', '2']);
      expect(
        (
          await store.listCalls('w', 10, undefined, {
            agentId: 'a',
            kind: 'test',
            status: 'pending',
            engine: 'engine-a',
            carrier: 'carrier-a',
          })
        ).items.map((item) => item.id),
      ).toEqual(['2']);
      expect(
        (await store.listCalls('w', 10, undefined, { engine: 'engine-b', carrier: 'carrier-a' }))
          .items,
      ).toEqual([]);
      await expect(store.listCalls('w', 10, 'bad-cursor')).rejects.toMatchObject({
        code: 'invalid_cursor',
      });
      expect((await store.getCall('w', '2'))?.kind).toBe('test');
      await store.close();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('upgrades pre-existing rows, preserves child references, rejects non-object selections, and leaves mixed-role OpenAI unresolved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ovo-f3-upgrade-'));
    const filename = join(dir, 'old.sqlite');
    try {
      const old = new DatabaseSync(filename);
      old.exec(`
        PRAGMA foreign_keys=ON;
        CREATE TABLE workspaces(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT NOT NULL);
        CREATE TABLE agents(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),config_json TEXT NOT NULL,draft_version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE releases(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),agent_id TEXT NOT NULL REFERENCES agents(id),draft_version INTEGER NOT NULL,config_json TEXT NOT NULL,plugins_json TEXT NOT NULL,provider_bindings_json TEXT NOT NULL DEFAULT '{}',mcp_tools_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL,created_by TEXT NOT NULL);
        CREATE TABLE provider_bindings(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),label TEXT NOT NULL,provider TEXT NOT NULL,environment TEXT NOT NULL,credential_id TEXT NOT NULL,config_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE calls(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),release_id TEXT NOT NULL REFERENCES releases(id),kind TEXT NOT NULL CHECK(kind IN ('live','simulation')),status TEXT NOT NULL,created_at TEXT NOT NULL,completed_at TEXT);
        CREATE TABLE call_events(id TEXT PRIMARY KEY,call_id TEXT NOT NULL REFERENCES calls(id),sequence INTEGER NOT NULL,at TEXT NOT NULL,type TEXT NOT NULL,epoch INTEGER NOT NULL,payload_json TEXT NOT NULL);
        INSERT INTO workspaces VALUES('w','W','2025-01-01');
        INSERT INTO provider_bindings VALUES('mixed','w','Mixed','openai','test','cred','{}','2025-01-01','2025-01-01');
        INSERT INTO provider_bindings VALUES('stt','w','STT','deepgram','test','cred','{}','2025-01-01','2025-01-01');
        INSERT INTO provider_bindings VALUES('tts','w','TTS','openai','test','cred','{}','2025-01-01','2025-01-01');
      `);
      for (const [id, providers] of [
        ['a', { tts: 'mixed', stt: 'stt' }],
        ['b', { inference: 'mixed' }],
        ['c', { tts: 'tts' }],
      ] as const) {
        old
          .prepare('INSERT INTO agents VALUES(?,?,?,?,?,?)')
          .run(id, 'w', JSON.stringify(config(id, providers)), 1, '2025-01-01', '2025-01-01');
      }
      old
        .prepare('INSERT INTO releases VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(
          'r',
          'w',
          'a',
          1,
          JSON.stringify(config('a', { tts: 'mixed', stt: 'stt' })),
          '[]',
          '{}',
          '{}',
          '2025-01-01',
          'test',
        );
      old.exec(
        "INSERT INTO calls VALUES('call','w','r','live','done','2025-01-01',NULL); INSERT INTO call_events VALUES('event','call',1,'2025-01-01','start',0,'{}');",
      );
      old.close();
      const store = new NodeSqliteControlStore(filename);
      expect((await store.getRelease('w', 'r'))?.selections).toEqual({});
      expect(await store.getProviderBinding('w', 'mixed')).toMatchObject({
        kind: null,
        pluginId: null,
      });
      expect(await store.getProviderBinding('w', 'stt')).toMatchObject({
        kind: 'stt',
        pluginId: '@winsendotai/ovo-provider-deepgram-stt',
      });
      expect(await store.getProviderBinding('w', 'tts')).toMatchObject({
        kind: 'tts',
        pluginId: '@winsendotai/ovo-provider-openai-tts',
      });
      expect((await store.listCallEvents('w', 'call')).items).toHaveLength(1);
      await store.createCall({ workspaceId: 'w', releaseId: 'r', kind: 'test', status: 'done' });
      await store.close();
      const rerun = new NodeSqliteControlStore(filename);
      expect((await rerun.getProviderBinding('w', 'mixed'))?.kind).toBeNull();
      await rerun.close();
      const db = new DatabaseSync(filename);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(() => db.exec("UPDATE releases SET selections_json='[]' WHERE id='r'")).toThrow();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('legacy selections', () => {
  it('derives unpinned choices from binding snapshots without inventing a version', () => {
    const release = {
      selections: {},
      config: config('Legacy', { stt: 'binding' }),
      providerBindings: { stt: { id: 'binding', provider: 'deepgram', pluginId: null } },
    } as unknown as Parameters<typeof deriveLegacySelections>[0];
    const registry = {
      resolve: (_kind: string, provider: string) => ({ manifest: { id: provider + '-plugin' } }),
      get: (id: string) => ({ manifest: { id } }),
    } as unknown as Parameters<typeof deriveLegacySelections>[1];
    const result = deriveLegacySelections(release, registry, { engine: 'default-engine' });
    expect(result).toEqual({
      stt: { pluginId: 'deepgram-plugin', bindingId: 'binding', config: {} },
      engine: { pluginId: 'default-engine', config: {} },
    });
    expect('version' in result.stt!).toBe(false);
    expect(() =>
      deriveLegacySelections({ ...release, providerBindings: {} }, registry, {}),
    ).toThrow('snapshot is missing');
    const missing = { resolve: registry.resolve, get: () => undefined } as Parameters<
      typeof deriveLegacySelections
    >[1];
    expect(() => deriveLegacySelections(release, missing, { engine: 'missing-engine' })).toThrow(
      'missing-engine',
    );
  });
});
