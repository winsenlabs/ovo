import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ProviderBinding } from '../models.ts';
import { cursorValue, json, now, pageLimit, parseObject, type Row } from './shared.ts';

export class BindingsRepository {
  constructor(private readonly db: DatabaseSync) {}
  private loadCredentialForBinding(workspaceId: string, id: string) {
    return this.db
      .prepare('SELECT status FROM credentials WHERE workspace_id=? AND id=?')
      .get(workspaceId, id) as { status: string } | undefined;
  }
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
      config: parseObject(row.config_json),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
  createProviderBinding(
    input: Omit<ProviderBinding, 'id' | 'createdAt' | 'updatedAt' | 'kind' | 'pluginId'> & {
      id?: string;
      kind?: string | null;
      pluginId?: string | null;
    },
  ) {
    const credential = this.loadCredentialForBinding(input.workspaceId, input.credentialId);
    if (!credential || credential.status !== 'active')
      throw new Error('Active credential not found');
    const id = input.id ?? randomUUID(),
      at = now();
    this.db
      .prepare(
        'INSERT INTO provider_bindings(id,workspace_id,label,provider,kind,plugin_id,environment,credential_id,config_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        input.workspaceId,
        input.label,
        input.provider,
        input.kind ?? null,
        input.pluginId ?? null,
        input.environment,
        input.credentialId,
        json(input.config),
        at,
        at,
      );
    return this.getProviderBinding(input.workspaceId, id)!;
  }
  getProviderBinding(workspaceId: string, id: string) {
    const row = this.db
      .prepare('SELECT * FROM provider_bindings WHERE workspace_id=? AND id=?')
      .get(workspaceId, id) as Row | undefined;
    return row ? this.mapBinding(row) : undefined;
  }
  listProviderBindings(workspaceId: string, limit = 50, cursor?: string) {
    const size = pageLimit(limit),
      rows = this.db
        .prepare(
          'SELECT rowid AS cursor,* FROM provider_bindings WHERE workspace_id=? AND rowid>? ORDER BY rowid LIMIT ?',
        )
        .all(workspaceId, cursorValue(cursor), size + 1) as Row[],
      more = rows.length > size;
    if (more) rows.pop();
    return {
      items: rows.map((row) => this.mapBinding(row)),
      nextCursor: more ? String(rows.at(-1)!.cursor) : null,
    };
  }
  updateProviderBinding(
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
    const credential = this.loadCredentialForBinding(workspaceId, input.credentialId);
    if (!credential || credential.status !== 'active')
      throw new Error('Active credential not found');
    const result = this.db
      .prepare(
        'UPDATE provider_bindings SET label=?,provider=?,environment=?,credential_id=?,config_json=?,updated_at=?,kind=CASE WHEN ? THEN CASE WHEN provider<>? THEN NULL ELSE kind END ELSE ? END,plugin_id=CASE WHEN ? THEN CASE WHEN provider<>? THEN NULL ELSE plugin_id END ELSE ? END WHERE workspace_id=? AND id=?',
      )
      .run(
        input.label,
        input.provider,
        input.environment,
        input.credentialId,
        json(input.config),
        now(),
        input.kind === undefined ? 1 : 0,
        input.provider,
        input.kind ?? null,
        input.pluginId === undefined ? 1 : 0,
        input.provider,
        input.pluginId ?? null,
        workspaceId,
        id,
      );
    if (!result.changes) throw new Error('Provider binding not found');
    return this.getProviderBinding(workspaceId, id)!;
  }
  deleteProviderBinding(workspaceId: string, id: string) {
    this.db
      .prepare('DELETE FROM provider_bindings WHERE workspace_id=? AND id=?')
      .run(workspaceId, id);
  }
}
