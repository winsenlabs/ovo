import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AgentConfig, type AgentConfig as AgentConfigValue } from '@winsendotai/ovo-contracts';
import {
  DraftConflictError,
  ReferencedResourceError,
  type AgentDraft,
  type Page,
  type ReleaseRecord,
} from '../models.ts';
import { cursorValue, json, now, pageLimit, parseArray, type Row, transaction } from './shared.ts';

export class AgentsRepository {
  constructor(private readonly db: DatabaseSync) {}
  ensureWorkspace(id: string, name = id) {
    this.db
      .prepare(
        'INSERT INTO workspaces(id,name,created_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING',
      )
      .run(id, name, now());
  }
  private mapAgent(row: Row): AgentDraft {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      config: AgentConfig.parse(JSON.parse(String(row.config_json))),
      draftVersion: Number(row.draft_version),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
  createAgent(workspaceId: string, config: AgentConfigValue, id = randomUUID()) {
    const at = now();
    this.db
      .prepare(
        'INSERT INTO agents(id,workspace_id,config_json,draft_version,created_at,updated_at) VALUES(?,?,?,?,?,?)',
      )
      .run(id, workspaceId, json(config), 1, at, at);
    return this.getAgent(workspaceId, id)!;
  }
  getAgent(workspaceId: string, id: string) {
    const row = this.db
      .prepare('SELECT * FROM agents WHERE workspace_id=? AND id=?')
      .get(workspaceId, id) as Row | undefined;
    return row ? this.mapAgent(row) : undefined;
  }
  listAgents(workspaceId: string, limit = 50, cursor?: string): Page<AgentDraft> {
    const size = pageLimit(limit),
      rows = this.db
        .prepare(
          'SELECT rowid AS cursor,* FROM agents WHERE workspace_id=? AND rowid>? ORDER BY rowid LIMIT ?',
        )
        .all(workspaceId, cursorValue(cursor), size + 1) as Row[],
      more = rows.length > size;
    if (more) rows.pop();
    return {
      items: rows.map((row) => this.mapAgent(row)),
      nextCursor: more ? String(rows.at(-1)!.cursor) : null,
    };
  }
  updateAgent(workspaceId: string, id: string, expectedVersion: number, config: AgentConfigValue) {
    return transaction(this.db, () => {
      const current = this.getAgent(workspaceId, id);
      if (!current) throw new Error('Agent not found');
      if (current.draftVersion !== expectedVersion) throw new DraftConflictError(current);
      this.db
        .prepare(
          'UPDATE agents SET config_json=?,draft_version=draft_version+1,updated_at=? WHERE workspace_id=? AND id=? AND draft_version=?',
        )
        .run(json(config), now(), workspaceId, id, expectedVersion);
      return this.getAgent(workspaceId, id)!;
    });
  }
  deleteAgent(workspaceId: string, id: string, expectedVersion: number) {
    transaction(this.db, () => {
      const current = this.getAgent(workspaceId, id);
      if (!current) throw new Error('Agent not found');
      if (current.draftVersion !== expectedVersion) throw new DraftConflictError(current);
      const releases = Number(
        (
          this.db
            .prepare('SELECT COUNT(*) AS count FROM releases WHERE workspace_id=? AND agent_id=?')
            .get(workspaceId, id) as Row
        ).count,
      );
      if (releases)
        throw new ReferencedResourceError('Agent has immutable releases.', { releases });
      this.db.prepare('DELETE FROM agents WHERE workspace_id=? AND id=?').run(workspaceId, id);
    });
  }
  private mapRelease(row: Row): ReleaseRecord {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      agentId: String(row.agent_id),
      draftVersion: Number(row.draft_version),
      config: AgentConfig.parse(JSON.parse(String(row.config_json))),
      plugins: parseArray(row.plugins_json),
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
  createRelease(input: {
    workspaceId: string;
    agent: AgentDraft;
    plugins: { id: string; version: string }[];
    createdBy: string;
    id?: string;
  }) {
    return transaction(this.db, () => {
      const current = this.getAgent(input.workspaceId, input.agent.id);
      if (!current) throw new Error('Agent not found');
      if (
        current.draftVersion !== input.agent.draftVersion ||
        json(current.config) !== json(input.agent.config)
      )
        throw new DraftConflictError(current);
      const existing = this.db
        .prepare('SELECT 1 FROM releases WHERE workspace_id=? AND agent_id=? AND draft_version=?')
        .get(input.workspaceId, input.agent.id, input.agent.draftVersion);
      if (existing)
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
          environment: String(row.environment),
          credentialId: String(row.credential_id),
          config: JSON.parse(String(row.config_json)) as Record<string, unknown>,
          createdAt: String(row.created_at),
          updatedAt: String(row.updated_at),
        };
      }
      const mcpTools: ReleaseRecord['mcpTools'] = {};
      for (const tool of input.agent.config.tools.filter(
        (candidate) =>
          candidate.connector === 'mcp' && input.agent.config.allowedTools.includes(candidate.id),
      )) {
        const approval = this.db
          .prepare(
            'SELECT * FROM agent_mcp_tools WHERE workspace_id=? AND agent_id=? AND tool_id=?',
          )
          .get(input.workspaceId, input.agent.id, tool.id) as Row | undefined;
        if (!approval) throw new Error(`MCP tool ${tool.id} is not currently approved`);
        const connection = this.db
          .prepare('SELECT * FROM mcp_connections WHERE workspace_id=? AND id=?')
          .get(input.workspaceId, String(approval.connection_id)) as Row | undefined;
        const discovered = this.db
          .prepare('SELECT * FROM mcp_discovered_tools WHERE connection_id=? AND remote_name=?')
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
            credentialId:
              connection.credential_id === null ? null : String(connection.credential_id),
            status: String(connection.status) as 'unverified' | 'ready' | 'error',
            createdAt: String(connection.created_at),
            updatedAt: String(connection.updated_at),
          },
          discoveredTool: {
            connectionId: String(discovered.connection_id),
            remoteName: String(discovered.remote_name),
            description: String(discovered.description),
            inputSchema: JSON.parse(String(discovered.input_schema_json)) as Record<
              string,
              unknown
            >,
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
          'INSERT INTO releases(id,workspace_id,agent_id,draft_version,config_json,plugins_json,provider_bindings_json,mcp_tools_json,created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          input.workspaceId,
          input.agent.id,
          input.agent.draftVersion,
          json(input.agent.config),
          json(input.plugins),
          json(providerBindings),
          json(mcpTools),
          now(),
          input.createdBy,
        );
      return this.getRelease(input.workspaceId, id)!;
    });
  }
  getRelease(workspaceId: string, id: string) {
    const row = this.db
      .prepare('SELECT * FROM releases WHERE workspace_id=? AND id=?')
      .get(workspaceId, id) as Row | undefined;
    return row ? this.mapRelease(row) : undefined;
  }
  listReleases(workspaceId: string, agentId: string, limit = 50, cursor?: string) {
    const size = pageLimit(limit),
      rows = this.db
        .prepare(
          'SELECT rowid AS cursor,* FROM releases WHERE workspace_id=? AND agent_id=? AND rowid>? ORDER BY rowid LIMIT ?',
        )
        .all(workspaceId, agentId, cursorValue(cursor), size + 1) as Row[],
      more = rows.length > size;
    if (more) rows.pop();
    return {
      items: rows.map((row) => this.mapRelease(row)),
      nextCursor: more ? String(rows.at(-1)!.cursor) : null,
    };
  }
}
