import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { AgentConfig, type AgentConfig as AgentConfigValue } from '@winsendotai/ovo-contracts';
import {
  DraftConflictError,
  ReferencedResourceError,
  type AgentDraft,
  type ProviderBinding,
  type ReleaseRecord,
} from '../models.ts';
import {
  decodeCursor,
  isUniqueViolation,
  now,
  pageFromRows,
  pageLimit,
  type Queryable,
  type Row,
  toIso,
  transaction,
} from './shared.ts';

export class PostgresAgentsRepository {
  constructor(private readonly pool: Pool) {}

  async ensureWorkspace(id: string, name = id) {
    await this.pool.query(
      `INSERT INTO ovo_ctl_workspaces(id,name,created_at) VALUES($1,$2,$3)
       ON CONFLICT(id) DO NOTHING`,
      [id, name, now()],
    );
  }

  private mapAgent(row: Row): AgentDraft {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      config: AgentConfig.parse(row.config),
      draftVersion: Number(row.draft_version),
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  async createAgent(workspaceId: string, config: AgentConfigValue, id = randomUUID()) {
    const at = now();
    const result = await this.pool.query<Row>(
      `INSERT INTO ovo_ctl_agents(workspace_id,id,config,draft_version,created_at,updated_at)
       VALUES($1,$2,$3,1,$4,$4) RETURNING *`,
      [workspaceId, id, config, at],
    );
    return this.mapAgent(result.rows[0]!);
  }

  async getAgent(workspaceId: string, id: string, query: Queryable = this.pool) {
    const result = await query.query<Row>(
      'SELECT * FROM ovo_ctl_agents WHERE workspace_id=$1 AND id=$2',
      [workspaceId, id],
    );
    return result.rowCount ? this.mapAgent(result.rows[0]!) : undefined;
  }

  async listAgents(workspaceId: string, limit = 50, cursor?: string) {
    const size = pageLimit(limit),
      after = decodeCursor(cursor);
    const result = await this.pool.query<Row>(
      `SELECT * FROM ovo_ctl_agents WHERE workspace_id=$1
       AND ($2::timestamptz IS NULL OR (created_at,id) > ($2::timestamptz,$3::text))
       ORDER BY created_at,id LIMIT $4`,
      [workspaceId, after?.at ?? null, after?.id ?? '', size + 1],
    );
    return pageFromRows(result.rows, size, (row) => this.mapAgent(row));
  }

  async updateAgent(
    workspaceId: string,
    id: string,
    expectedVersion: number,
    config: AgentConfigValue,
  ) {
    const result = await this.pool.query<Row>(
      `UPDATE ovo_ctl_agents SET config=$1,draft_version=draft_version+1,updated_at=$2
       WHERE workspace_id=$3 AND id=$4 AND draft_version=$5 RETURNING *`,
      [config, now(), workspaceId, id, expectedVersion],
    );
    if (result.rowCount) return this.mapAgent(result.rows[0]!);
    const current = await this.getAgent(workspaceId, id);
    if (!current) throw new Error('Agent not found');
    throw new DraftConflictError(current);
  }

  async deleteAgent(workspaceId: string, id: string, expectedVersion: number) {
    await transaction(this.pool, async (client) => {
      const row = await client.query<Row>(
        'SELECT * FROM ovo_ctl_agents WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
        [workspaceId, id],
      );
      if (!row.rowCount) throw new Error('Agent not found');
      const current = this.mapAgent(row.rows[0]!);
      if (current.draftVersion !== expectedVersion) throw new DraftConflictError(current);
      const references = await client.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM ovo_ctl_releases WHERE workspace_id=$1 AND agent_id=$2',
        [workspaceId, id],
      );
      const releases = Number(references.rows[0]!.count);
      if (releases)
        throw new ReferencedResourceError('Agent has immutable releases.', { releases });
      await client.query('DELETE FROM ovo_ctl_agents WHERE workspace_id=$1 AND id=$2', [
        workspaceId,
        id,
      ]);
    });
  }

  private mapRelease(row: Row): ReleaseRecord {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      agentId: String(row.agent_id),
      draftVersion: Number(row.draft_version),
      config: AgentConfig.parse(row.config),
      plugins: row.plugins as ReleaseRecord['plugins'],
      providerBindings: (row.provider_bindings ?? {}) as ReleaseRecord['providerBindings'],
      mcpTools: (row.mcp_tools ?? {}) as ReleaseRecord['mcpTools'],
      createdAt: toIso(row.created_at),
      createdBy: String(row.created_by),
    };
  }

  async createRelease(input: {
    workspaceId: string;
    agent: AgentDraft;
    plugins: { id: string; version: string }[];
    createdBy: string;
    id?: string;
  }) {
    return transaction(this.pool, async (client) => {
      const locked = await client.query<Row>(
        'SELECT * FROM ovo_ctl_agents WHERE workspace_id=$1 AND id=$2 FOR SHARE',
        [input.workspaceId, input.agent.id],
      );
      if (!locked.rowCount) throw new Error('Agent not found');
      const current = this.mapAgent(locked.rows[0]!);
      if (
        current.draftVersion !== input.agent.draftVersion ||
        !isDeepStrictEqual(current.config, input.agent.config)
      )
        throw new DraftConflictError(current);
      const providerBindings: Record<string, ProviderBinding> = {};
      for (const [slot, bindingId] of Object.entries(input.agent.config.providers)) {
        const binding = await client.query<Row>(
          `SELECT * FROM ovo_ctl_provider_bindings
           WHERE workspace_id=$1 AND id=$2 FOR SHARE`,
          [input.workspaceId, bindingId],
        );
        if (!binding.rowCount) throw new Error(`Provider binding ${bindingId} is missing`);
        const row = binding.rows[0]!;
        providerBindings[slot] = {
          id: String(row.id),
          workspaceId: String(row.workspace_id),
          label: String(row.label),
          provider: String(row.provider),
          environment: String(row.environment),
          credentialId: String(row.credential_id),
          config: row.config as Record<string, unknown>,
          createdAt: toIso(row.created_at),
          updatedAt: toIso(row.updated_at),
        };
      }
      const mcpTools: ReleaseRecord['mcpTools'] = {};
      for (const tool of input.agent.config.tools.filter(
        (candidate) =>
          candidate.connector === 'mcp' && input.agent.config.allowedTools.includes(candidate.id),
      )) {
        const approvalResult = await client.query<Row>(
          `SELECT * FROM ovo_ctl_agent_mcp_tools
           WHERE workspace_id=$1 AND agent_id=$2 AND tool_id=$3 FOR SHARE`,
          [input.workspaceId, input.agent.id, tool.id],
        );
        if (!approvalResult.rowCount)
          throw new Error(`MCP tool ${tool.id} is not currently approved`);
        const approval = approvalResult.rows[0]!;
        const [connectionResult, discoveredResult] = await Promise.all([
          client.query<Row>(
            `SELECT * FROM ovo_ctl_mcp_connections
             WHERE workspace_id=$1 AND id=$2 AND status='ready' FOR SHARE`,
            [input.workspaceId, approval.connection_id],
          ),
          client.query<Row>(
            `SELECT * FROM ovo_ctl_mcp_discovered_tools
             WHERE workspace_id=$1 AND connection_id=$2 AND remote_name=$3 FOR SHARE`,
            [input.workspaceId, approval.connection_id, approval.remote_name],
          ),
        ]);
        const connection = connectionResult.rows[0],
          discovered = discoveredResult.rows[0];
        if (
          !connection ||
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
            createdAt: toIso(approval.created_at),
            updatedAt: toIso(approval.updated_at),
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
            createdAt: toIso(connection.created_at),
            updatedAt: toIso(connection.updated_at),
          },
          discoveredTool: {
            connectionId: String(discovered.connection_id),
            remoteName: String(discovered.remote_name),
            description: String(discovered.description),
            inputSchema: discovered.input_schema as Record<string, unknown>,
            outputSchema: (discovered.output_schema as Record<string, unknown> | null) ?? null,
            schemaDigest: String(discovered.schema_digest),
            discoveredAt: toIso(discovered.discovered_at),
          },
        };
      }
      const id = input.id ?? randomUUID();
      try {
        const result = await client.query<Row>(
          `INSERT INTO ovo_ctl_releases
           (workspace_id,id,agent_id,draft_version,config,plugins,provider_bindings,mcp_tools,created_at,created_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [
            input.workspaceId,
            id,
            input.agent.id,
            input.agent.draftVersion,
            input.agent.config,
            JSON.stringify(input.plugins),
            providerBindings,
            mcpTools,
            now(),
            input.createdBy,
          ],
        );
        return this.mapRelease(result.rows[0]!);
      } catch (error) {
        if (isUniqueViolation(error))
          throw Object.assign(new Error('This draft version already has an immutable release'), {
            statusCode: 409,
            code: 'release_conflict',
          });
        throw error;
      }
    });
  }

  async getRelease(workspaceId: string, id: string) {
    const result = await this.pool.query<Row>(
      'SELECT * FROM ovo_ctl_releases WHERE workspace_id=$1 AND id=$2',
      [workspaceId, id],
    );
    return result.rowCount ? this.mapRelease(result.rows[0]!) : undefined;
  }

  async listReleases(workspaceId: string, agentId: string, limit = 50, cursor?: string) {
    const size = pageLimit(limit),
      after = decodeCursor(cursor);
    const result = await this.pool.query<Row>(
      `SELECT * FROM ovo_ctl_releases WHERE workspace_id=$1 AND agent_id=$2
       AND ($3::timestamptz IS NULL OR (created_at,id) > ($3::timestamptz,$4::text))
       ORDER BY created_at,id LIMIT $5`,
      [workspaceId, agentId, after?.at ?? null, after?.id ?? '', size + 1],
    );
    return pageFromRows(result.rows, size, (row) => this.mapRelease(row));
  }
}
