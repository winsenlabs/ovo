import type { PoolClient } from 'pg';
import type { McpConnection, McpToolApproval } from '../models.ts';
import { toIso, type Row } from './shared.ts';
export function mapConnection(
  row: Row,
  timestamp: (value: unknown) => string = toIso,
): McpConnection {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    label: String(row.label),
    endpoint: String(row.endpoint),
    auth: String(row.auth) as McpConnection['auth'],
    credentialId: row.credential_id === null ? null : String(row.credential_id),
    status: String(row.status) as McpConnection['status'],
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

export async function validateCredential(
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

export function mapApproval(
  row: Row,
  timestamp: (value: unknown) => string = toIso,
): McpToolApproval {
  return {
    workspaceId: String(row.workspace_id),
    agentId: String(row.agent_id),
    toolId: String(row.tool_id),
    connectionId: String(row.connection_id),
    remoteName: String(row.remote_name),
    schemaDigest: String(row.schema_digest),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}
