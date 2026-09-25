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
  type ReleaseSelection,
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
}
