import { randomUUID } from 'node:crypto';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import { describe, expect, it, vi } from 'vitest';
import { open, config, databaseUrl } from './fixture-admission-support.ts';
for (const backend of ['sqlite', 'postgres']) {
  (backend === 'postgres' && !databaseUrl ? describe.skip : describe)(
    `${backend} durable fixture admission`,
    () => {
      it('keeps snapshots private, preserves publication slots, and rejects non-test consumers', async () => {
        const db = await open(backend);
        const { store, peer } = db;
        try {
          await store.ensureWorkspace('w');
          await store.ensureWorkspace('other');
          const agent = await store.createAgent('w', config());
          const admitted = await store.createFixtureCall({
            workspaceId: 'w',
            id: randomUUID(),
            agentId: agent.id,
            fingerprint: 'request',
            draft: {
              workspaceId: 'w',
              agent,
              plugins: [{ id: 'engine.fixture', version: '1.0.0' }],
              selections: { engine: { pluginId: 'engine.fixture', version: '1.0.0', config: {} } },
              createdBy: 'test',
            },
          });
          const snapshot = await peer.getFixtureCallRelease('w', admitted.call.id);
          expect(snapshot?.config).toEqual(agent.config);
          expect(snapshot?.selections?.engine?.version).toBe('1.0.0');
          expect(await peer.getRelease('w', admitted.call.releaseId)).toBeUndefined();
          expect((await peer.listReleases('w', agent.id)).items).toEqual([]);
          expect(await peer.getFixtureCallRelease('other', admitted.call.id)).toBeUndefined();
          for (const kind of ['live', 'simulation'] as const)
            await expect(
              store.createCall({
                workspaceId: 'w',
                releaseId: admitted.call.releaseId,
                kind,
                status: 'running',
              }),
            ).rejects.toThrow('Release is unavailable');
          const published = await store.createRelease({
            workspaceId: 'w',
            agent,
            plugins: [],
            createdBy: 'publisher',
          });
          expect((await peer.listReleases('w', agent.id)).items.map((row) => row.id)).toEqual([
            published.id,
          ]);
          await expect(
            store.createRelease({ workspaceId: 'w', agent, plugins: [], createdBy: 'publisher' }),
          ).rejects.toMatchObject({ code: 'release_conflict' });
          await store.updateAgent(
            'w',
            agent.id,
            agent.draftVersion,
            config('Edited after admission'),
          );
          expect((await peer.getFixtureCallRelease('w', admitted.call.id))?.config).toEqual(
            agent.config,
          );
          expect(
            (
              await peer.listCalls('w', 50, undefined, {
                kind: 'test',
                agentId: agent.id,
                engine: 'engine.fixture',
              })
            ).items.map((row) => row.id),
          ).toEqual([admitted.call.id]);
        } finally {
          await db.close();
        }
      });
      it('serializes identical concurrent requests and refuses changed payloads without extra snapshots', async () => {
        const db = await open(backend);
        const { store, peer } = db;
        try {
          await store.ensureWorkspace('w');
          const agent = await store.createAgent('w', config());
          const request = {
            workspaceId: 'w',
            id: randomUUID(),
            agentId: agent.id,
            fingerprint: 'same',
            draft: { workspaceId: 'w', agent, plugins: [], createdBy: 'test' },
          };
          const results = await Promise.all([
            store.createFixtureCall(request),
            peer.createFixtureCall(request),
          ]);
          expect(results.map((row) => row.created).sort()).toEqual([false, true]);
          expect(results[0]!.call).toEqual(results[1]!.call);
          const events = await peer.listCallEvents('w', request.id);
          expect(events.items).toHaveLength(1);
          expect(events.items[0]).toMatchObject({
            sequence: 1,
            type: 'fixture.request',
            payload: {
              fingerprint: 'same',
              agentId: agent.id,
              releaseId: results[0]!.call.releaseId,
            },
          });
          await expect(
            peer.createFixtureCall({ ...request, fingerprint: 'changed' }),
          ).rejects.toMatchObject({ code: 'idempotency_conflict' });
          expect(await db.count('releases')).toBe(1);
          expect(await db.count('calls')).toBe(1);
          expect(await db.count('call_events')).toBe(1);
        } finally {
          await db.close();
        }
      });
      it('rolls back the draft snapshot and call if initial event persistence fails', async () => {
        const db = await open(backend);
        const { store } = db;
        try {
          await store.ensureWorkspace('w');
          const agent = await store.createAgent('w', config());
          await db.sql(
            "CREATE TRIGGER refuse_fixture_event BEFORE INSERT ON call_events BEGIN SELECT RAISE(ABORT,'initial event refused'); END;",
            "CREATE FUNCTION refuse_fixture_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'initial event refused'; END $$; CREATE TRIGGER refuse_fixture_event BEFORE INSERT ON ovo_ctl_call_events FOR EACH ROW EXECUTE FUNCTION refuse_fixture_event();",
          );
          await expect(
            store.createFixtureCall({
              workspaceId: 'w',
              id: randomUUID(),
              agentId: agent.id,
              fingerprint: 'request',
              draft: { workspaceId: 'w', agent, plugins: [], createdBy: 'test' },
            }),
          ).rejects.toThrow('initial event refused');
          expect(await db.count('releases')).toBe(0);
          expect(await db.count('calls')).toBe(0);
          expect(await db.count('call_events')).toBe(0);
        } finally {
          await db.close();
        }
      });
      it('pins provider and MCP state and refuses a binding changed during draft preparation', async () => {
        const db = await open(backend);
        const { store, peer } = db;
        try {
          await store.ensureWorkspace('w');
          const credential = await store.createCredential({
            workspaceId: 'w',
            label: 'Fixture',
            provider: 'fixture',
            type: 'key',
            environment: 'test',
            backend: 'local',
            permittedAgentIds: [],
            createdBy: 'test',
            fingerprint: 'original',
            secret: {
              ciphertext: Buffer.from('fixture'),
              nonce: Buffer.alloc(12),
              authTag: Buffer.alloc(16),
              backendRef: null,
            },
          });
          const binding = await store.createProviderBinding({
            workspaceId: 'w',
            label: 'Fixture binding',
            provider: 'fixture',
            environment: 'test',
            credentialId: credential.id,
            config: { model: 'original' },
          });
          const connection = await store.createMcpConnection({
            workspaceId: 'w',
            label: 'Fixture MCP',
            endpoint: 'https://fixture.invalid/mcp',
            auth: 'none',
          });
          await store.replaceMcpDiscoveredTools('w', connection.id, [
            {
              remoteName: 'lookup',
              description: 'Lookup',
              inputSchema: { type: 'object' },
              outputSchema: null,
              schemaDigest: 'original',
            },
          ]);
          await store.setMcpConnectionStatus('w', connection.id, 'ready');
          const agent = await store.createAgent(
            'w',
            AgentConfig.parse({
              ...config(),
              providers: { inference: binding.id },
              allowedTools: ['lookup'],
              tools: [
                {
                  id: 'lookup',
                  description: 'Lookup',
                  connector: 'mcp',
                  connectionId: connection.id,
                  remoteName: 'lookup',
                  schemaDigest: 'original',
                  inputSchema: { type: 'object' },
                  effect: 'read',
                },
              ],
            }),
          );
          await store.upsertMcpApproval({
            workspaceId: 'w',
            agentId: agent.id,
            toolId: 'lookup',
            connectionId: connection.id,
            remoteName: 'lookup',
            schemaDigest: 'original',
          });
          const draft = {
            workspaceId: 'w',
            agent,
            plugins: [],
            selections: {
              llm: {
                pluginId: 'fixture.llm',
                version: '1.2.3',
                bindingId: binding.id,
                binding: {
                  provider: binding.provider,
                  config: binding.config,
                  credentialId: credential.id,
                  fingerprint: credential.fingerprint,
                  updatedAt: binding.updatedAt,
                },
                config: {},
              },
            },
            createdBy: 'test',
          };
          const call = await store.createFixtureCall({
            workspaceId: 'w',
            id: randomUUID(),
            agentId: agent.id,
            fingerprint: 'pins',
            draft,
          });
          await store.updateProviderBinding('w', binding.id, {
            label: binding.label,
            provider: binding.provider,
            environment: binding.environment,
            credentialId: credential.id,
            config: { model: 'changed' },
          });
          const snapshot = await peer.getFixtureCallRelease('w', call.call.id);
          expect(snapshot?.providerBindings.inference?.config).toEqual({ model: 'original' });
          expect(snapshot?.selections?.llm?.binding).toEqual(draft.selections.llm.binding);
          expect(snapshot?.mcpTools.lookup?.connection).toMatchObject({
            endpoint: connection.endpoint,
            status: 'ready',
          });
          await expect(
            store.createFixtureCall({
              workspaceId: 'w',
              id: randomUUID(),
              agentId: agent.id,
              fingerprint: 'new',
              draft,
            }),
          ).rejects.toMatchObject({ code: 'binding_conflict' });
          await db.sql(
            "UPDATE mcp_discovered_tools SET schema_digest='changed'",
            "UPDATE ovo_ctl_mcp_discovered_tools SET schema_digest='changed'",
          );
          expect(
            (await peer.getFixtureCallRelease('w', call.call.id))?.mcpTools.lookup?.discoveredTool
              .schemaDigest,
          ).toBe('original');
          await expect(
            store.createFixtureCall({
              workspaceId: 'w',
              id: randomUUID(),
              agentId: agent.id,
              fingerprint: 'mcp',
              draft: { ...draft, selections: {} },
            }),
          ).rejects.toThrow('not currently approved');
          expect(await db.count('calls')).toBe(1);
        } finally {
          await db.close();
        }
      });
      it.each(['pluginId', 'kind'] as const)(
        'refuses same-timestamp binding %s changes without creating mixed snapshots',
        async (field) => {
          const db = await open(backend);
          const { store } = db;
          vi.useFakeTimers({ toFake: ['Date'] });
          vi.setSystemTime(new Date('2026-09-27T06:00:00Z'));
          try {
            await store.ensureWorkspace('w');
            const credential = await store.createCredential({
              workspaceId: 'w',
              label: 'Identity',
              provider: 'fixture',
              type: 'key',
              environment: 'test',
              backend: 'local',
              permittedAgentIds: [],
              createdBy: 'test',
              fingerprint: 'same',
              secret: {
                ciphertext: Buffer.from('fixture'),
                nonce: Buffer.alloc(12),
                authTag: Buffer.alloc(16),
                backendRef: null,
              },
            });
            const input = {
              workspaceId: 'w',
              label: 'Identity',
              provider: 'fixture',
              environment: 'test',
              credentialId: credential.id,
              config: {},
              kind: 'llm',
              pluginId: 'fixture.llm.a',
            };
            const binding = await store.createProviderBinding(input);
            const agent = await store.createAgent(
              'w',
              AgentConfig.parse({ ...config(), providers: { inference: binding.id } }),
            );
            const selections = {
              llm: {
                pluginId: 'fixture.llm.a',
                version: '1.0.0',
                bindingId: binding.id,
                config: {},
                binding: {
                  provider: binding.provider,
                  config: binding.config,
                  credentialId: credential.id,
                  fingerprint: credential.fingerprint,
                  updatedAt: binding.updatedAt,
                },
              },
            };
            const changed = await store.updateProviderBinding('w', binding.id, {
              ...input,
              [field]: field === 'pluginId' ? 'fixture.llm.b' : 'tts',
            });
            expect(changed.updatedAt).toBe(binding.updatedAt);
            await expect(
              store.createFixtureCall({
                workspaceId: 'w',
                id: randomUUID(),
                agentId: agent.id,
                fingerprint: 'identity',
                draft: { workspaceId: 'w', agent, plugins: [], selections, createdBy: 'test' },
              }),
            ).rejects.toMatchObject({ code: 'binding_conflict' });
            expect(await db.count('releases')).toBe(0);
            expect(await db.count('calls')).toBe(0);
            expect(await db.count('call_events')).toBe(0);
          } finally {
            vi.useRealTimers();
            await db.close();
          }
        },
      );
      it('upgrades a populated pre-006 database without changing published calls or initial evidence', async () => {
        const db = await open(backend);
        const { store } = db;
        try {
          await store.ensureWorkspace('w');
          const agent = await store.createAgent('w', config());
          const release = await store.createRelease({
            workspaceId: 'w',
            agent,
            plugins: [],
            createdBy: 'publisher',
          });
          const call = await store.createCall({
            workspaceId: 'w',
            releaseId: release.id,
            kind: 'simulation',
            status: 'completed',
          });
          const event = await store.appendCallEvent('w', call.id, 'existing', { retained: true });
          await db.sql(
            'DROP INDEX releases_published_draft_idx; ALTER TABLE releases DROP COLUMN purpose; ALTER TABLE mcp_discovered_tools DROP COLUMN removed_at; DELETE FROM ovo_control_schema_migrations WHERE version IN (5,6,7);',
            'DROP INDEX ovo_ctl_releases_published_draft_idx; ALTER TABLE ovo_ctl_releases DROP COLUMN purpose; ALTER TABLE ovo_ctl_releases ADD UNIQUE(workspace_id,agent_id,draft_version); ALTER TABLE ovo_ctl_mcp_discovered_tools DROP COLUMN removed_at; DELETE FROM ovo_control_schema_migrations WHERE version IN (6,7);',
          );
          await db.remigrate();
          expect(await store.getRelease('w', release.id)).toEqual(release);
          expect(await store.getCall('w', call.id)).toEqual(call);
          expect((await store.listCallEvents('w', call.id)).items).toEqual([event]);
          expect(await db.versions()).toEqual([1, 2, 3, 4, 5, 6, 7]);
          await db.remigrate();
          expect(await db.versions()).toEqual([1, 2, 3, 4, 5, 6, 7]);
        } finally {
          await db.close();
        }
      });
      it('rejects stale drafts and release IDs from other agents or fixture snapshots', async () => {
        const db = await open(backend);
        const { store } = db;
        try {
          await store.ensureWorkspace('w');
          const agent = await store.createAgent('w', config());
          const request = {
            workspaceId: 'w',
            id: randomUUID(),
            agentId: agent.id,
            fingerprint: 'request',
            draft: { workspaceId: 'w', agent, plugins: [], createdBy: 'test' },
          };
          const first = await store.createFixtureCall(request);
          await expect(
            store.createFixtureCall({
              workspaceId: 'w',
              id: randomUUID(),
              agentId: agent.id,
              fingerprint: 'release',
              releaseId: first.call.releaseId,
            }),
          ).rejects.toMatchObject({ code: 'not_found' });
          const release = await store.createRelease(request.draft);
          await expect(
            store.createFixtureCall({
              workspaceId: 'w',
              id: randomUUID(),
              agentId: 'another',
              fingerprint: 'release',
              releaseId: release.id,
            }),
          ).rejects.toMatchObject({ code: 'not_found' });
          await store.updateAgent('w', agent.id, agent.draftVersion, config('changed'));
          await expect(store.createFixtureCall({ ...request, id: randomUUID() })).rejects.toThrow(
            /draft/i,
          );
          expect(await db.count('calls')).toBe(1);
        } finally {
          await db.close();
        }
      });
    },
  );
}
