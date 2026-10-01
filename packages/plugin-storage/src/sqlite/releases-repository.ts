import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import type { ControlStore } from '../control-store.ts';
type ReleaseInput = Parameters<ControlStore['createRelease']>[0];
import {
  DraftConflictError,
  type AgentDraft,
  type ReleaseRecord,
  type ReleaseSelection,
} from '../models.ts';
import { fixtureSelectionKind } from '../postgres/releases-repository.ts';
import { AgentsRepository } from './agents-repository.ts';
import { json, now, parseArray, selectPage, type Row, transaction } from './shared.ts';

export class ReleasesRepository {
  constructor(private readonly db: DatabaseSync) {}
  private loadAgentForRelease(workspaceId: string, id: string) {
    return new AgentsRepository(this.db).getAgent(workspaceId, id);
  }
  static mapRelease(row: Row): ReleaseRecord {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      agentId: String(row.agent_id),
      draftVersion: Number(row.draft_version),
      config: AgentConfig.parse(JSON.parse(String(row.config_json))),
      plugins: parseArray(row.plugins_json),
      selections:
        row.selections_json === undefined
          ? {}
          : (JSON.parse(String(row.selections_json)) as ReleaseRecord['selections']),
      providerBindings:
        row.provider_bindings_json === undefined
          ? {}
          : (JSON.parse(String(row.provider_bindings_json)) as ReleaseRecord['providerBindings']),
      mcpTools:
        row.mcp_tools_json === undefined
          ? {}
          : (JSON.parse(String(row.mcp_tools_json)) as ReleaseRecord['mcpTools']),
      createdAt: String(row.created_at),
      createdBy: String(row.created_by),
    };
  }
  createRelease(input: ReleaseInput) {
    return transaction(this.db, () => this.insertRelease(input, 'published'));
  }
  static createFixtureSnapshot(db: DatabaseSync, input: ReleaseInput) {
    return new ReleasesRepository(db).insertRelease(input, 'fixture-snapshot');
  }
  private insertRelease(input: ReleaseInput, purpose: 'published' | 'fixture-snapshot') {
    const current = this.loadAgentForRelease(input.workspaceId, input.agent.id);
    if (!current) throw new Error('Agent not found');
    if (
      current.draftVersion !== input.agent.draftVersion ||
      json(current.config) !== json(input.agent.config)
    )
      throw new DraftConflictError(current);
    const existing = this.db
      .prepare(
        "SELECT 1 FROM releases WHERE workspace_id=? AND agent_id=? AND draft_version=? AND purpose='published'",
      )
      .get(input.workspaceId, input.agent.id, input.agent.draftVersion);
    if (purpose === 'published' && existing)
      throw Object.assign(new Error('This draft version already has an immutable release'), {
        statusCode: 409,
        code: 'release_conflict',
      });
    const providerBindings: ReleaseRecord['providerBindings'] = {};
    for (const [slot, bindingId] of Object.entries(input.agent.config.providers)) {
      const row = this.db
        .prepare('SELECT * FROM provider_bindings WHERE workspace_id=? AND id=?')
        .get(input.workspaceId, bindingId) as Row | undefined;
      if (!row) throw new Error(`Provider binding ${bindingId} is missing`);
      providerBindings[slot] = {
        id: String(row.id),
        workspaceId: String(row.workspace_id),
        label: String(row.label),
        provider: String(row.provider),
        kind: row.kind === null ? null : String(row.kind),
        pluginId: row.plugin_id === null ? null : String(row.plugin_id),
        environment: String(row.environment),
        credentialId: String(row.credential_id),
        config: JSON.parse(String(row.config_json)) as Record<string, unknown>,
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      };
    }
    // Fixture snapshots pin voice bindings under the same transaction as the draft.
    // A binding edited after selection preparation must be retried, never silently mixed.
    if (purpose === 'fixture-snapshot')
      for (const [slot, selection] of Object.entries(input.selections ?? {})) {
        if (!selection.bindingId || selection.bindingId === 'env') continue;
        const binding = this.db
          .prepare(
            `SELECT b.*, c.fingerprint FROM provider_bindings b JOIN credentials c ON c.workspace_id=b.workspace_id AND c.id=b.credential_id WHERE b.workspace_id=? AND b.id=?`,
          )
          .get(input.workspaceId, selection.bindingId) as Row | undefined;
        const pin = selection.binding;
        if (
          !binding ||
          !pin ||
          // Legacy null identities remain valid; declared identities must match the selection.
          (binding.plugin_id != null && binding.plugin_id !== selection.pluginId) ||
          (binding.kind != null && binding.kind !== fixtureSelectionKind(slot)) ||
          pin.provider !== binding.provider ||
          pin.credentialId !== binding.credential_id ||
          pin.fingerprint !== binding.fingerprint ||
          pin.updatedAt !== String(binding.updated_at) ||
          !isDeepStrictEqual(pin.config, JSON.parse(String(binding.config_json)))
        )
          throw Object.assign(new Error('Fixture provider binding changed'), {
            statusCode: 409,
            code: 'binding_conflict',
          });
      }
    const mcpTools: ReleaseRecord['mcpTools'] = {};
    for (const tool of input.agent.config.tools.filter(
      (candidate) =>
        candidate.connector === 'mcp' && input.agent.config.allowedTools.includes(candidate.id),
    )) {
      const approval = this.db
        .prepare('SELECT * FROM agent_mcp_tools WHERE workspace_id=? AND agent_id=? AND tool_id=?')
        .get(input.workspaceId, input.agent.id, tool.id) as Row | undefined;
      if (!approval) throw new Error(`MCP tool ${tool.id} is not currently approved`);
      const connection = this.db
        .prepare('SELECT * FROM mcp_connections WHERE workspace_id=? AND id=?')
        .get(input.workspaceId, String(approval.connection_id)) as Row | undefined;
      const discovered = this.db
        .prepare(
          'SELECT * FROM mcp_discovered_tools WHERE connection_id=? AND remote_name=? AND removed_at IS NULL',
        )
        .get(String(approval.connection_id), String(approval.remote_name)) as Row | undefined;
      if (
        !connection ||
        connection.status !== 'ready' ||
        !discovered ||
        String(approval.connection_id) !== tool.connectionId ||
        String(approval.remote_name) !== tool.remoteName ||
        String(approval.schema_digest) !== tool.schemaDigest ||
        String(discovered.schema_digest) !== tool.schemaDigest
      )
        throw new Error(`MCP tool ${tool.id} is not currently approved`);
      mcpTools[tool.id] = {
        approval: {
          workspaceId: String(approval.workspace_id),
          agentId: String(approval.agent_id),
          toolId: String(approval.tool_id),
          connectionId: String(approval.connection_id),
          remoteName: String(approval.remote_name),
          schemaDigest: String(approval.schema_digest),
          createdAt: String(approval.created_at),
          updatedAt: String(approval.updated_at),
        },
        connection: {
          id: String(connection.id),
          workspaceId: String(connection.workspace_id),
          label: String(connection.label),
          endpoint: String(connection.endpoint),
          auth: String(connection.auth) as 'none' | 'bearer',
          credentialId: connection.credential_id === null ? null : String(connection.credential_id),
          status: String(connection.status) as 'unverified' | 'ready' | 'error',
          createdAt: String(connection.created_at),
          updatedAt: String(connection.updated_at),
        },
        discoveredTool: {
          connectionId: String(discovered.connection_id),
          remoteName: String(discovered.remote_name),
          description: String(discovered.description),
          inputSchema: JSON.parse(String(discovered.input_schema_json)) as Record<string, unknown>,
          outputSchema:
            discovered.output_schema_json === null
              ? null
              : (JSON.parse(String(discovered.output_schema_json)) as Record<string, unknown>),
          schemaDigest: String(discovered.schema_digest),
          discoveredAt: String(discovered.discovered_at),
        },
      };
    }
    const id = input.id ?? randomUUID();
    this.db
      .prepare(
        'INSERT INTO releases(id,workspace_id,agent_id,draft_version,config_json,plugins_json,selections_json,provider_bindings_json,mcp_tools_json,created_at,created_by,purpose) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        input.workspaceId,
        input.agent.id,
        input.agent.draftVersion,
        json(input.agent.config),
        json(input.plugins),
        json(input.selections ?? {}),
        json(providerBindings),
        json(mcpTools),
        now(),
        input.createdBy,
        purpose,
      );
    return ReleasesRepository.mapRelease(
      this.db
        .prepare('SELECT * FROM releases WHERE workspace_id=? AND id=?')
        .get(input.workspaceId, id) as Row,
    );
  }
  getRelease(workspaceId: string, id: string) {
    const row = this.db
      .prepare("SELECT * FROM releases WHERE workspace_id=? AND id=? AND purpose='published'")
      .get(workspaceId, id) as Row | undefined;
    return row ? ReleasesRepository.mapRelease(row) : undefined;
  }
  getFixtureCallRelease(workspaceId: string, callId: string) {
    const row = this.db
      .prepare(
        `SELECT r.* FROM releases r JOIN calls c
      ON c.workspace_id=r.workspace_id AND c.release_id=r.id
      WHERE c.workspace_id=? AND c.id=? AND c.kind='test'`,
      )
      .get(workspaceId, callId) as Row | undefined;
    return row ? ReleasesRepository.mapRelease(row) : undefined;
  }

  listReleases(workspaceId: string, agentId: string, limit = 50, cursor?: string) {
    return selectPage(
      this.db,
      "SELECT rowid AS cursor,* FROM releases WHERE workspace_id=? AND agent_id=? AND purpose='published' AND rowid>? ORDER BY rowid LIMIT ?",
      [workspaceId, agentId],
      limit,
      cursor,
      (row) => ReleasesRepository.mapRelease(row),
    );
  }
}
