import type { CallRecord } from './models.ts';

export function mapCall(
  row: Record<string, unknown>,
  timestamp: (value: unknown) => string,
): CallRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    releaseId: String(row.release_id),
    kind: String(row.kind) as CallRecord['kind'],
    status: String(row.status),
    createdAt: timestamp(row.created_at),
    completedAt: row.completed_at === null ? null : timestamp(row.completed_at),
  };
}
