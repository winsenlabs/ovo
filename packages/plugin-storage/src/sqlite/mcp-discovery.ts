import type { DatabaseSync } from 'node:sqlite';
import type { McpDiscoveredTool } from '../models.ts';
import { json, now, parseObject, transaction, type Row } from './shared.ts';

export function replaceDiscovered(
  db: DatabaseSync,
  workspaceId: string,
  connectionId: string,
  tools: Omit<McpDiscoveredTool, 'connectionId' | 'discoveredAt'>[],
) {
  if (tools.length > 100) throw new Error('MCP discovery exceeds the 100 tool limit');
  return transaction(db, () => {
    if (
      !db
        .prepare('SELECT 1 FROM mcp_connections WHERE workspace_id=? AND id=?')
        .get(workspaceId, connectionId)
    )
      throw new Error('MCP connection not found');
    const discoveredAt = now();
    const missing = tools.length
      ? ` AND remote_name NOT IN (${tools.map(() => '?').join(',')})`
      : '';
    db.prepare(
      `UPDATE mcp_discovered_tools SET removed_at=COALESCE(removed_at,?) WHERE connection_id=?${missing}`,
    ).run(discoveredAt, connectionId, ...tools.map((tool) => tool.remoteName));
    const insert = db.prepare(
      'INSERT INTO mcp_discovered_tools(connection_id,remote_name,description,input_schema_json,output_schema_json,schema_digest,discovered_at,removed_at) VALUES(?,?,?,?,?,?,?,NULL) ON CONFLICT(connection_id,remote_name) DO UPDATE SET description=excluded.description,input_schema_json=excluded.input_schema_json,output_schema_json=excluded.output_schema_json,schema_digest=excluded.schema_digest,discovered_at=excluded.discovered_at,removed_at=NULL',
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
    return tools.map((tool) => ({ ...tool, connectionId, discoveredAt, removedAt: null }));
  });
}

export function mapDiscovered(row: Row): McpDiscoveredTool {
  return {
    connectionId: String(row.connection_id),
    remoteName: String(row.remote_name),
    description: String(row.description),
    inputSchema: parseObject(row.input_schema_json),
    outputSchema: row.output_schema_json === null ? null : parseObject(row.output_schema_json),
    schemaDigest: String(row.schema_digest),
    discoveredAt: String(row.discovered_at),
    removedAt: row.removed_at == null ? null : String(row.removed_at),
  };
}
