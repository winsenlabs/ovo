import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  ReferencedResourceError,
  type McpConnection,
  type McpDiscoveredTool,
  type McpToolApproval,
} from '../models.ts';
import {
  decodeCursor,
  now,
  pageFromRows,
  pageLimit,
  type Row,
  toIso,
  transaction,
} from './shared.ts';

export class PostgresMcpRepository {
  constructor(private readonly pool: Pool) {}

  private mapConnection(row: Row): McpConnection {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      label: String(row.label),
      endpoint: String(row.endpoint),
      auth: String(row.auth) as McpConnection['auth'],
      credentialId: row.credential_id === null ? null : String(row.credential_id),
      status: String(row.status) as McpConnection['status'],
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  private async validateCredential(
    client: PoolClient,
    workspaceId: string,
    auth: 'none' | 'bearer',
    credentialId?: string | null,
  ) {
    if (auth === 'none') {
      if (credentialId) throw new Error('Unauthenticated MCP connection cannot use a credential');
      return;
    }
    if (!credentialId) throw new Error('Bearer MCP connection requires a credential');
    const result = await client.query(
      `SELECT 1 FROM ovo_ctl_credentials
       WHERE workspace_id=$1 AND id=$2 AND status='active' FOR SHARE`,
      [workspaceId, credentialId],
    );
    if (!result.rowCount) throw new Error('Active credential not found');
  }

  async createMcpConnection(input: {
    workspaceId: string;
    label: string;
    endpoint: string;
    auth: 'none' | 'bearer';
    credentialId?: string | null;
    id?: string;
  }) {
    return transaction(this.pool, async (client) => {
      await this.validateCredential(client, input.workspaceId, input.auth, input.credentialId);
      const id = input.id ?? randomUUID(),
        at = now();
      const result = await client.query<Row>(
        `INSERT INTO ovo_ctl_mcp_connections
         (workspace_id,id,label,endpoint,auth,credential_id,status,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,'unverified',$7,$7) RETURNING *`,
        [
          input.workspaceId,
          id,
          input.label,
          input.endpoint,
          input.auth,
          input.credentialId ?? null,
          at,
        ],
      );
      return this.mapConnection(result.rows[0]!);
    });
  }

  async getMcpConnection(workspaceId: string, id: string) {
    const result = await this.pool.query<Row>(
      'SELECT * FROM ovo_ctl_mcp_connections WHERE workspace_id=$1 AND id=$2',
      [workspaceId, id],
    );
    return result.rowCount ? this.mapConnection(result.rows[0]!) : undefined;
  }

  async listMcpConnections(workspaceId: string, limit = 50, cursor?: string) {
    const size = pageLimit(limit),
      after = decodeCursor(cursor);
    const result = await this.pool.query<Row>(
      `SELECT * FROM ovo_ctl_mcp_connections WHERE workspace_id=$1
       AND ($2::timestamptz IS NULL OR (created_at,id) > ($2::timestamptz,$3::text))
       ORDER BY created_at,id LIMIT $4`,
      [workspaceId, after?.at ?? null, after?.id ?? '', size + 1],
    );
    return pageFromRows(result.rows, size, (row) => this.mapConnection(row));
  }

  async updateMcpConnection(
    workspaceId: string,
    id: string,
    input: {
      label: string;
      endpoint: string;
      auth: 'none' | 'bearer';
      credentialId?: string | null;
    },
  ) {
    return transaction(this.pool, async (client) => {
      await this.validateCredential(client, workspaceId, input.auth, input.credentialId);
      const result = await client.query<Row>(
        `UPDATE ovo_ctl_mcp_connections
         SET label=$1,endpoint=$2,auth=$3,credential_id=$4,status='unverified',updated_at=$5
         WHERE workspace_id=$6 AND id=$7 RETURNING *`,
        [
          input.label,
          input.endpoint,
          input.auth,
          input.credentialId ?? null,
          now(),
          workspaceId,
          id,
        ],
      );
      if (!result.rowCount) throw new Error('MCP connection not found');
      return this.mapConnection(result.rows[0]!);
    });
  }

  async setMcpConnectionStatus(workspaceId: string, id: string, status: McpConnection['status']) {
    const result = await this.pool.query<Row>(
      `UPDATE ovo_ctl_mcp_connections SET status=$1,updated_at=$2
       WHERE workspace_id=$3 AND id=$4 RETURNING *`,
      [status, now(), workspaceId, id],
    );
    if (!result.rowCount) throw new Error('MCP connection not found');
    return this.mapConnection(result.rows[0]!);
  }

  async deleteMcpConnection(workspaceId: string, id: string) {
    await transaction(this.pool, async (client) => {
      const locked = await client.query(
        'SELECT 1 FROM ovo_ctl_mcp_connections WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
        [workspaceId, id],
      );
      if (!locked.rowCount) return;
      const references = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM ovo_ctl_agent_mcp_tools
         WHERE workspace_id=$1 AND connection_id=$2`,
        [workspaceId, id],
      );
      const approvals = Number(references.rows[0]!.count);
      if (approvals)
        throw new ReferencedResourceError('MCP connection has agent tool approvals.', {
          approvals,
        });
      await client.query('DELETE FROM ovo_ctl_mcp_connections WHERE workspace_id=$1 AND id=$2', [
        workspaceId,
        id,
      ]);
    });
  }

  private mapDiscovered(row: Row): McpDiscoveredTool {
    return {
      connectionId: String(row.connection_id),
      remoteName: String(row.remote_name),
      description: String(row.description),
      inputSchema: row.input_schema as Record<string, unknown>,
      outputSchema: (row.output_schema as Record<string, unknown> | null) ?? null,
      schemaDigest: String(row.schema_digest),
      discoveredAt: toIso(row.discovered_at),
    };
  }

  async replaceMcpDiscoveredTools(
    workspaceId: string,
    connectionId: string,
    tools: Omit<McpDiscoveredTool, 'connectionId' | 'discoveredAt'>[],
  ) {
    if (tools.length > 100) throw new Error('MCP discovery exceeds the 100 tool limit');
    return transaction(this.pool, async (client) => {
      const connection = await client.query(
        'SELECT 1 FROM ovo_ctl_mcp_connections WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
        [workspaceId, connectionId],
      );
      if (!connection.rowCount) throw new Error('MCP connection not found');
      await client.query(
        'DELETE FROM ovo_ctl_mcp_discovered_tools WHERE workspace_id=$1 AND connection_id=$2',
        [workspaceId, connectionId],
      );
      const discoveredAt = now();
      for (const tool of tools)
        await client.query(
          `INSERT INTO ovo_ctl_mcp_discovered_tools
           (workspace_id,connection_id,remote_name,description,input_schema,output_schema,
            schema_digest,discovered_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            workspaceId,
            connectionId,
            tool.remoteName,
            tool.description,
            tool.inputSchema,
            tool.outputSchema,
            tool.schemaDigest,
            discoveredAt,
          ],
        );
      return tools.map((tool) => ({ ...tool, connectionId, discoveredAt }));
    });
  }

  async getMcpDiscoveredTool(workspaceId: string, connectionId: string, remoteName: string) {
    const result = await this.pool.query<Row>(
      `SELECT * FROM ovo_ctl_mcp_discovered_tools
       WHERE workspace_id=$1 AND connection_id=$2 AND remote_name=$3`,
      [workspaceId, connectionId, remoteName],
    );
    return result.rowCount ? this.mapDiscovered(result.rows[0]!) : undefined;
  }

  async listMcpDiscoveredTools(
    workspaceId: string,
    connectionId: string,
    limit = 50,
    cursor?: string,
  ) {
    const size = pageLimit(limit),
      after = decodeCursor(cursor);
    const result = await this.pool.query<Row>(
      `SELECT *,remote_name AS id FROM ovo_ctl_mcp_discovered_tools
       WHERE workspace_id=$1 AND connection_id=$2
       AND ($3::timestamptz IS NULL OR (discovered_at,remote_name) > ($3::timestamptz,$4::text))
       ORDER BY discovered_at,remote_name LIMIT $5`,
      [workspaceId, connectionId, after?.at ?? null, after?.id ?? '', size + 1],
    );
    return pageFromRows(
      result.rows,
      size,
      (row) => this.mapDiscovered(row),
      (row) => ({
        at: toIso(row.discovered_at),
        id: String(row.remote_name),
      }),
    );
  }

  private mapApproval(row: Row): McpToolApproval {
    return {
      workspaceId: String(row.workspace_id),
      agentId: String(row.agent_id),
      toolId: String(row.tool_id),
      connectionId: String(row.connection_id),
      remoteName: String(row.remote_name),
      schemaDigest: String(row.schema_digest),
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  async upsertMcpApproval(input: {
    workspaceId: string;
    agentId: string;
    toolId: string;
    connectionId: string;
    remoteName: string;
    schemaDigest: string;
  }) {
    return transaction(this.pool, async (client) => {
      const agent = await client.query(
        'SELECT 1 FROM ovo_ctl_agents WHERE workspace_id=$1 AND id=$2 FOR SHARE',
        [input.workspaceId, input.agentId],
      );
      if (!agent.rowCount) throw new Error('Agent not found');
      const discovered = await client.query<{ schema_digest: string }>(
        `SELECT schema_digest FROM ovo_ctl_mcp_discovered_tools
         WHERE workspace_id=$1 AND connection_id=$2 AND remote_name=$3 FOR SHARE`,
        [input.workspaceId, input.connectionId, input.remoteName],
      );
      if (!discovered.rowCount || discovered.rows[0]!.schema_digest !== input.schemaDigest)
        throw new Error('Approval must match the latest discovered MCP schema');
      const at = now();
      const result = await client.query<Row>(
        `INSERT INTO ovo_ctl_agent_mcp_tools
         (workspace_id,agent_id,tool_id,connection_id,remote_name,schema_digest,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$7)
         ON CONFLICT(workspace_id,agent_id,tool_id) DO UPDATE SET
           connection_id=excluded.connection_id,remote_name=excluded.remote_name,
           schema_digest=excluded.schema_digest,updated_at=excluded.updated_at
         RETURNING *`,
        [
          input.workspaceId,
          input.agentId,
          input.toolId,
          input.connectionId,
          input.remoteName,
          input.schemaDigest,
          at,
        ],
      );
      return this.mapApproval(result.rows[0]!);
    });
  }

  async getMcpApproval(workspaceId: string, agentId: string, toolId: string) {
    const result = await this.pool.query<Row>(
      `SELECT * FROM ovo_ctl_agent_mcp_tools
       WHERE workspace_id=$1 AND agent_id=$2 AND tool_id=$3`,
      [workspaceId, agentId, toolId],
    );
    return result.rowCount ? this.mapApproval(result.rows[0]!) : undefined;
  }

  async listMcpApprovals(workspaceId: string, agentId: string, limit = 50, cursor?: string) {
    const size = pageLimit(limit),
      after = decodeCursor(cursor);
    const result = await this.pool.query<Row>(
      `SELECT *,tool_id AS id FROM ovo_ctl_agent_mcp_tools
       WHERE workspace_id=$1 AND agent_id=$2
       AND ($3::timestamptz IS NULL OR (created_at,tool_id) > ($3::timestamptz,$4::text))
       ORDER BY created_at,tool_id LIMIT $5`,
      [workspaceId, agentId, after?.at ?? null, after?.id ?? '', size + 1],
    );
    return pageFromRows(
      result.rows,
      size,
      (row) => this.mapApproval(row),
      (row) => ({
        at: toIso(row.created_at),
        id: String(row.tool_id),
      }),
    );
  }

  async deleteMcpApproval(workspaceId: string, agentId: string, toolId: string) {
    await this.pool.query(
      `DELETE FROM ovo_ctl_agent_mcp_tools
       WHERE workspace_id=$1 AND agent_id=$2 AND tool_id=$3`,
      [workspaceId, agentId, toolId],
    );
  }
}
