import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  CreateProviderBindingInput,
  ProviderBinding,
  UpdateProviderBindingInput,
} from '../models.ts';
import { mapProviderBinding } from '../binding-mapping.ts';
import { json, now, parseObject, selectPage, type Row } from './shared.ts';

export class BindingsRepository {
  constructor(private readonly db: DatabaseSync) {}
  private loadCredentialForBinding(workspaceId: string, id: string) {
    return this.db
      .prepare('SELECT status FROM credentials WHERE workspace_id=? AND id=?')
      .get(workspaceId, id) as { status: string } | undefined;
  }
  private mapBinding(row: Row): ProviderBinding {
    return mapProviderBinding(row, 'config_json', parseObject, String);
  }
  createProviderBinding(input: CreateProviderBindingInput) {
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
    return selectPage(
      this.db,
      'SELECT rowid AS cursor,* FROM provider_bindings WHERE workspace_id=? AND rowid>? ORDER BY rowid LIMIT ?',
      [workspaceId],
      limit,
      cursor,
      (row) => this.mapBinding(row),
    );
  }
  updateProviderBinding(workspaceId: string, id: string, input: UpdateProviderBindingInput) {
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
