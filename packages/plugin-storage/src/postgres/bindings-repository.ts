import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { ProviderBinding } from '../models.ts';
import {
  decodeCursor,
  now,
  pageFromRows,
  pageLimit,
  type Row,
  toIso,
  transaction,
} from './shared.ts';

export class PostgresBindingsRepository {
  constructor(private readonly pool: Pool) {}
  private mapBinding(row: Row): ProviderBinding {
    return {
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

  private async lockActiveCredential(client: PoolClient, workspaceId: string, id: string) {
    const result = await client.query(
      `SELECT 1 FROM ovo_ctl_credentials
       WHERE workspace_id=$1 AND id=$2 AND status='active' FOR SHARE`,
      [workspaceId, id],
    );
    if (!result.rowCount) throw new Error('Active credential not found');
  }

  async createProviderBinding(
    input: Omit<ProviderBinding, 'id' | 'createdAt' | 'updatedAt' | 'kind' | 'pluginId'> & {
      id?: string;
      kind?: string | null;
      pluginId?: string | null;
    },
  ) {
    return transaction(this.pool, async (client) => {
      await this.lockActiveCredential(client, input.workspaceId, input.credentialId);
      const id = input.id ?? randomUUID(),
        at = now();
      const result = await client.query<Row>(
        `INSERT INTO ovo_ctl_provider_bindings
         (workspace_id,id,label,provider,kind,plugin_id,environment,credential_id,config,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING *`,
        [
          input.workspaceId,
          id,
          input.label,
          input.provider,
          input.kind ?? null,
          input.pluginId ?? null,
          input.environment,
          input.credentialId,
          input.config,
          at,
        ],
      );
      return this.mapBinding(result.rows[0]!);
    });
  }

  async getProviderBinding(workspaceId: string, id: string) {
    const result = await this.pool.query<Row>(
      'SELECT * FROM ovo_ctl_provider_bindings WHERE workspace_id=$1 AND id=$2',
      [workspaceId, id],
    );
    return result.rowCount ? this.mapBinding(result.rows[0]!) : undefined;
  }

  async listProviderBindings(workspaceId: string, limit = 50, cursor?: string) {
    const size = pageLimit(limit),
      after = decodeCursor(cursor);
    const result = await this.pool.query<Row>(
      `SELECT * FROM ovo_ctl_provider_bindings WHERE workspace_id=$1
       AND ($2::timestamptz IS NULL OR (created_at,id) > ($2::timestamptz,$3::text))
       ORDER BY created_at,id LIMIT $4`,
      [workspaceId, after?.at ?? null, after?.id ?? '', size + 1],
    );
    return pageFromRows(result.rows, size, (row) => this.mapBinding(row));
  }

  async updateProviderBinding(
    workspaceId: string,
    id: string,
    input: {
      label: string;
      provider: string;
      environment: string;
      credentialId: string;
      config: Record<string, unknown>;
      kind?: string | null;
      pluginId?: string | null;
    },
  ) {
    return transaction(this.pool, async (client) => {
      await this.lockActiveCredential(client, workspaceId, input.credentialId);
      const result = await client.query<Row>(
        `UPDATE ovo_ctl_provider_bindings
         SET label=$1,provider=$2,environment=$3,credential_id=$4,config=$5,updated_at=$6,
             kind=CASE WHEN $11::boolean THEN CASE WHEN provider<>$2 THEN NULL ELSE kind END ELSE $9::text END,
             plugin_id=CASE WHEN $12::boolean THEN CASE WHEN provider<>$2 THEN NULL ELSE plugin_id END ELSE $10::text END
         WHERE workspace_id=$7 AND id=$8 RETURNING *`,
        [
          input.label,
          input.provider,
          input.environment,
          input.credentialId,
          input.config,
          now(),
          workspaceId,
          id,
          input.kind ?? null,
          input.pluginId ?? null,
          input.kind === undefined,
          input.pluginId === undefined,
        ],
      );
      if (!result.rowCount) throw new Error('Provider binding not found');
      return this.mapBinding(result.rows[0]!);
    });
  }

  async deleteProviderBinding(workspaceId: string, id: string) {
    await this.pool.query('DELETE FROM ovo_ctl_provider_bindings WHERE workspace_id=$1 AND id=$2', [
      workspaceId,
      id,
    ]);
  }
}
