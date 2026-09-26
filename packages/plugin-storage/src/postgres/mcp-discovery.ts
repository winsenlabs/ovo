import type { Pool } from 'pg';
import type { McpDiscoveredTool } from '../models.ts';
import { now, toIso, transaction, type Row } from './shared.ts';

export function mapDiscovered(row: Row): McpDiscoveredTool {
  return {
    connectionId: String(row.connection_id),
    remoteName: String(row.remote_name),
    description: String(row.description),
    inputSchema: row.input_schema as Record<string, unknown>,
    outputSchema: (row.output_schema as Record<string, unknown> | null) ?? null,
    schemaDigest: String(row.schema_digest),
    discoveredAt: toIso(row.discovered_at),
    removedAt: row.removed_at == null ? null : toIso(row.removed_at),
  };
}

export async function replaceDiscovered(
  pool: Pool,
  workspaceId: string,
  connectionId: string,
  tools: Omit<McpDiscoveredTool, 'connectionId' | 'discoveredAt'>[],
) {
  if (tools.length > 100) throw new Error('MCP discovery exceeds the 100 tool limit');
  return transaction(pool, async (client) => {
    const connection = await client.query(
      'SELECT 1 FROM ovo_ctl_mcp_connections WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
      [workspaceId, connectionId],
    );
    if (!connection.rowCount) throw new Error('MCP connection not found');
    const discoveredAt = now();
    await client.query(
      `UPDATE ovo_ctl_mcp_discovered_tools SET removed_at=COALESCE(removed_at,$3)
         WHERE workspace_id=$1 AND connection_id=$2 AND NOT(remote_name=ANY($4::text[]))`,
      [workspaceId, connectionId, discoveredAt, tools.map((tool) => tool.remoteName)],
    );
    for (const tool of tools)
      await client.query(
        `INSERT INTO ovo_ctl_mcp_discovered_tools
           (workspace_id,connection_id,remote_name,description,input_schema,output_schema,
            schema_digest,discovered_at,removed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL)
           ON CONFLICT(workspace_id,connection_id,remote_name) DO UPDATE SET
             description=excluded.description,input_schema=excluded.input_schema,
             output_schema=excluded.output_schema,schema_digest=excluded.schema_digest,
             discovered_at=excluded.discovered_at,removed_at=NULL`,
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
    return tools.map((tool) => ({ ...tool, connectionId, discoveredAt, removedAt: null }));
  });
}
