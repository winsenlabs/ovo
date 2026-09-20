import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  ReferencedResourceError,
  type AgentDraft,
  type CredentialMetadata,
  type McpConnection,
  type McpDiscoveredTool,
  type McpToolApproval,
} from '../models.ts';
import { json, now, parseObject, type Row, transaction } from './shared.ts';

export class McpRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly getCredential: (w: string, id: string) => CredentialMetadata | undefined,
    private readonly getAgent: (w: string, id: string) => AgentDraft | undefined,
  ) {}
  private map(row: Row): McpConnection {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      label: String(row.label),
      endpoint: String(row.endpoint),
      auth: String(row.auth) as McpConnection['auth'],
      credentialId: row.credential_id === null ? null : String(row.credential_id),
      status: String(row.status) as McpConnection['status'],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
  createMcpConnection(input: {
    workspaceId: string;
    label: string;
    endpoint: string;
    auth: 'none' | 'bearer';
    credentialId?: string | null;
    id?: string;
  }) {
    this.validateCredential(input.workspaceId, input.auth, input.credentialId);
    const id = input.id ?? randomUUID(),
      at = now();
    this.db
      .prepare(
        "INSERT INTO mcp_connections(id,workspace_id,label,endpoint,auth,credential_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'unverified',?,?)",
      )
      .run(
        id,
        input.workspaceId,
        input.label,
        input.endpoint,
        input.auth,
        input.credentialId ?? null,
        at,
        at,
      );
    return this.getMcpConnection(input.workspaceId, id)!;
  }
  getMcpConnection(workspaceId: string, id: string) {
    const row = this.db
      .prepare('SELECT * FROM mcp_connections WHERE workspace_id=? AND id=?')
      .get(workspaceId, id) as Row | undefined;
    return row ? this.map(row) : undefined;
  }
  listMcpConnections(workspaceId: string) {
    return (
      this.db
        .prepare('SELECT * FROM mcp_connections WHERE workspace_id=? ORDER BY created_at DESC')
        .all(workspaceId) as Row[]
    ).map((row) => this.map(row));
  }
  updateMcpConnection(
    workspaceId: string,
    id: string,
    input: {
      label: string;
      endpoint: string;
      auth: 'none' | 'bearer';
      credentialId?: string | null;
    },
  ) {
    this.validateCredential(workspaceId, input.auth, input.credentialId);
    const result = this.db
      .prepare(
        "UPDATE mcp_connections SET label=?,endpoint=?,auth=?,credential_id=?,status='unverified',updated_at=? WHERE workspace_id=? AND id=?",
      )
      .run(
        input.label,
        input.endpoint,
        input.auth,
        input.credentialId ?? null,
        now(),
        workspaceId,
        id,
      );
    if (!result.changes) throw new Error('MCP connection not found');
    return this.getMcpConnection(workspaceId, id)!;
  }
  private validateCredential(
    workspaceId: string,
    auth: 'none' | 'bearer',
    credentialId?: string | null,
  ) {
    if (auth === 'bearer' && !credentialId)
      throw new Error('Bearer MCP connection requires a credential');
    if (credentialId && !this.getCredential(workspaceId, credentialId))
      throw new Error('Credential not found');
  }
  setMcpConnectionStatus(workspaceId: string, id: string, status: McpConnection['status']) {
    const result = this.db
      .prepare('UPDATE mcp_connections SET status=?,updated_at=? WHERE workspace_id=? AND id=?')
      .run(status, now(), workspaceId, id);
    if (!result.changes) throw new Error('MCP connection not found');
    return this.getMcpConnection(workspaceId, id)!;
  }
  deleteMcpConnection(workspaceId: string, id: string) {
    const count = Number(
      (
        this.db
          .prepare(
            'SELECT COUNT(*) AS count FROM agent_mcp_tools WHERE workspace_id=? AND connection_id=?',
          )
          .get(workspaceId, id) as Row
      ).count,
    );
    if (count)
      throw new ReferencedResourceError('MCP connection has agent tool approvals.', {
        approvals: count,
      });
    this.db
      .prepare('DELETE FROM mcp_connections WHERE workspace_id=? AND id=?')
      .run(workspaceId, id);
  }
  replaceMcpDiscoveredTools(
    workspaceId: string,
    connectionId: string,
    tools: Omit<McpDiscoveredTool, 'connectionId' | 'discoveredAt'>[],
  ) {
    return transaction(this.db, () => {
      if (!this.getMcpConnection(workspaceId, connectionId))
        throw new Error('MCP connection not found');
      this.db.prepare('DELETE FROM mcp_discovered_tools WHERE connection_id=?').run(connectionId);
      const discoveredAt = now(),
        insert = this.db.prepare(
          'INSERT INTO mcp_discovered_tools(connection_id,remote_name,description,input_schema_json,output_schema_json,schema_digest,discovered_at) VALUES(?,?,?,?,?,?,?)',
        );
      for (const tool of tools)
        insert.run(
          connectionId,
          tool.remoteName,
          tool.description,
          json(tool.inputSchema),
          tool.outputSchema === null ? null : json(tool.outputSchema),
          tool.schemaDigest,
          discoveredAt,
        );
      return this.listMcpDiscoveredTools(workspaceId, connectionId);
    });
  }
  listMcpDiscoveredTools(workspaceId: string, connectionId: string): McpDiscoveredTool[] {
    if (!this.getMcpConnection(workspaceId, connectionId))
      throw new Error('MCP connection not found');
    return (
      this.db
        .prepare('SELECT * FROM mcp_discovered_tools WHERE connection_id=? ORDER BY remote_name')
        .all(connectionId) as Row[]
    ).map((row) => ({
      connectionId: String(row.connection_id),
      remoteName: String(row.remote_name),
      description: String(row.description),
      inputSchema: parseObject(row.input_schema_json),
      outputSchema: row.output_schema_json === null ? null : parseObject(row.output_schema_json),
      schemaDigest: String(row.schema_digest),
      discoveredAt: String(row.discovered_at),
    }));
  }
  upsertMcpApproval(input: {
    workspaceId: string;
    agentId: string;
    toolId: string;
    connectionId: string;
    remoteName: string;
    schemaDigest: string;
  }) {
    if (!this.getAgent(input.workspaceId, input.agentId)) throw new Error('Agent not found');
    if (!this.getMcpConnection(input.workspaceId, input.connectionId))
      throw new Error('MCP connection not found');
    const at = now();
    this.db
      .prepare(
        'INSERT INTO agent_mcp_tools(workspace_id,agent_id,tool_id,connection_id,remote_name,schema_digest,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,agent_id,tool_id) DO UPDATE SET connection_id=excluded.connection_id,remote_name=excluded.remote_name,schema_digest=excluded.schema_digest,updated_at=excluded.updated_at',
      )
      .run(
        input.workspaceId,
        input.agentId,
        input.toolId,
        input.connectionId,
        input.remoteName,
        input.schemaDigest,
        at,
        at,
      );
    return this.getMcpApproval(input.workspaceId, input.agentId, input.toolId)!;
  }
  getMcpApproval(
    workspaceId: string,
    agentId: string,
    toolId: string,
  ): McpToolApproval | undefined {
    const row = this.db
      .prepare('SELECT * FROM agent_mcp_tools WHERE workspace_id=? AND agent_id=? AND tool_id=?')
      .get(workspaceId, agentId, toolId) as Row | undefined;
    return row
      ? {
          workspaceId: String(row.workspace_id),
          agentId: String(row.agent_id),
          toolId: String(row.tool_id),
          connectionId: String(row.connection_id),
          remoteName: String(row.remote_name),
          schemaDigest: String(row.schema_digest),
          createdAt: String(row.created_at),
          updatedAt: String(row.updated_at),
        }
      : undefined;
  }
  listMcpApprovals(workspaceId: string, agentId: string) {
    return (
      this.db
        .prepare(
          'SELECT tool_id FROM agent_mcp_tools WHERE workspace_id=? AND agent_id=? ORDER BY tool_id',
        )
        .all(workspaceId, agentId) as Row[]
    ).map((row) => this.getMcpApproval(workspaceId, agentId, String(row.tool_id))!);
  }
  deleteMcpApproval(workspaceId: string, agentId: string, toolId: string) {
    this.db
      .prepare('DELETE FROM agent_mcp_tools WHERE workspace_id=? AND agent_id=? AND tool_id=?')
      .run(workspaceId, agentId, toolId);
  }
}
