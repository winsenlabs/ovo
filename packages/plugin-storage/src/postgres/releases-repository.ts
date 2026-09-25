import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import {
  DraftConflictError,
  type AgentDraft,
  type ProviderBinding,
  type ReleaseRecord,
  type ReleaseSelection,
} from '../models.ts';
import {
  decodeCursor,
  isUniqueViolation,
  now,
  pageFromRows,
  pageLimit,
  type Row,
  toIso,
  transaction,
} from './shared.ts';

export class PostgresReleasesRepository {
  constructor(private readonly pool: Pool) {}
  private mapReleaseAgent(row: Row): AgentDraft {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      config: AgentConfig.parse(row.config),
      draftVersion: Number(row.draft_version),
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  private mapRelease(row: Row): ReleaseRecord {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      agentId: String(row.agent_id),
      draftVersion: Number(row.draft_version),
      config: AgentConfig.parse(row.config),
      plugins: row.plugins as ReleaseRecord['plugins'],
      selections: (row.selections ?? {}) as ReleaseRecord['selections'],
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
    selections?: Record<string, ReleaseSelection>;
    createdBy: string;
    id?: string;
  }) {
    return transaction(this.pool, async (client) => {
      const locked = await client.query<Row>(
        'SELECT * FROM ovo_ctl_agents WHERE workspace_id=$1 AND id=$2 FOR SHARE',
        [input.workspaceId, input.agent.id],
      );
      if (!locked.rowCount) throw new Error('Agent not found');
      const current = this.mapReleaseAgent(locked.rows[0]!);
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
          kind: row.kind === null ? null : String(row.kind),
          pluginId: row.plugin_id === null ? null : String(row.plugin_id),
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
           (workspace_id,id,agent_id,draft_version,config,plugins,selections,provider_bindings,mcp_tools,created_at,created_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [
            input.workspaceId,
            id,
            input.agent.id,
            input.agent.draftVersion,
            input.agent.config,
            JSON.stringify(input.plugins),
            input.selections ?? {},
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
