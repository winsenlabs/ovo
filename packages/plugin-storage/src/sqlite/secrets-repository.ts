import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  ReferencedResourceError,
  type CredentialMetadata,
  type CredentialReferences,
  type ProviderBinding,
  type SecretBlob,
} from '../models.ts';
import {
  cursorValue,
  json,
  now,
  pageLimit,
  parseArray,
  parseObject,
  type Row,
  transaction,
} from './shared.ts';

export class SecretsRepository {
  constructor(private readonly db: DatabaseSync) {}
  private mapCredential(row: Row): CredentialMetadata {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      label: String(row.label),
      provider: String(row.provider),
      type: String(row.type),
      environment: String(row.environment),
      backend: String(row.backend) as CredentialMetadata['backend'],
      currentVersion: Number(row.current_version),
      status: String(row.status) as CredentialMetadata['status'],
      permittedAgentIds: parseArray(row.permitted_agent_ids_json),
      expiresAt: row.expires_at === null ? null : String(row.expires_at),
      createdBy: String(row.created_by),
      createdAt: String(row.created_at),
      rotatedAt: row.rotated_at === null ? null : String(row.rotated_at),
      retiredAt: row.retired_at === null ? null : String(row.retired_at),
      fingerprint: String(row.fingerprint),
    };
  }
  createCredential(input: {
    workspaceId: string;
    label: string;
    provider: string;
    type: string;
    environment: string;
    backend: CredentialMetadata['backend'];
    permittedAgentIds: string[];
    expiresAt?: string | null;
    createdBy: string;
    fingerprint: string;
    secret: Omit<SecretBlob, 'credentialId' | 'version' | 'backend'>;
    id?: string;
  }) {
    return transaction(this.db, () => {
      const id = input.id ?? randomUUID(),
        at = now();
      this.db
        .prepare(
          "INSERT INTO credentials(id,workspace_id,label,provider,type,environment,backend,current_version,status,permitted_agent_ids_json,expires_at,created_by,created_at,fingerprint) VALUES(?,?,?,?,?,?,?,1,'active',?,?,?,?,?)",
        )
        .run(
          id,
          input.workspaceId,
          input.label,
          input.provider,
          input.type,
          input.environment,
          input.backend,
          json(input.permittedAgentIds),
          input.expiresAt ?? null,
          input.createdBy,
          at,
          input.fingerprint,
        );
      this.db
        .prepare(
          'INSERT INTO secret_versions(credential_id,version,ciphertext,nonce,auth_tag,backend_ref,created_at) VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          id,
          1,
          input.secret.ciphertext,
          input.secret.nonce,
          input.secret.authTag,
          input.secret.backendRef,
          at,
        );
      return this.getCredential(input.workspaceId, id)!;
    });
  }
  rotateCredential(
    workspaceId: string,
    id: string,
    input: {
      fingerprint: string;
      secret: Omit<SecretBlob, 'credentialId' | 'version' | 'backend'>;
    },
  ) {
    return transaction(this.db, () => {
      const current = this.getCredential(workspaceId, id);
      if (!current || current.status !== 'active') throw new Error('Active credential not found');
      const version = current.currentVersion + 1,
        at = now();
      this.db
        .prepare(
          'INSERT INTO secret_versions(credential_id,version,ciphertext,nonce,auth_tag,backend_ref,created_at) VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          id,
          version,
          input.secret.ciphertext,
          input.secret.nonce,
          input.secret.authTag,
          input.secret.backendRef,
          at,
        );
      this.db
        .prepare(
          'UPDATE credentials SET current_version=?,rotated_at=?,fingerprint=? WHERE workspace_id=? AND id=?',
        )
        .run(version, at, input.fingerprint, workspaceId, id);
      return this.getCredential(workspaceId, id)!;
    });
  }
  getCredential(workspaceId: string, id: string) {
    const row = this.db
      .prepare('SELECT * FROM credentials WHERE workspace_id=? AND id=?')
      .get(workspaceId, id) as Row | undefined;
    return row ? this.mapCredential(row) : undefined;
  }
  listCredentials(workspaceId: string, limit = 50, cursor?: string) {
    const size = pageLimit(limit),
      rows = this.db
        .prepare(
          'SELECT rowid AS cursor,* FROM credentials WHERE workspace_id=? AND rowid>? ORDER BY rowid LIMIT ?',
        )
        .all(workspaceId, cursorValue(cursor), size + 1) as Row[],
      more = rows.length > size;
    if (more) rows.pop();
    return {
      items: rows.map((row) => this.mapCredential(row)),
      nextCursor: more ? String(rows.at(-1)!.cursor) : null,
    };
  }
  getActiveSecretBlob(workspaceId: string, id: string): SecretBlob | undefined {
    const row = this.db
      .prepare(
        "SELECT c.id AS credential_id,c.current_version,c.backend,s.ciphertext,s.nonce,s.auth_tag,s.backend_ref FROM credentials c JOIN secret_versions s ON s.credential_id=c.id AND s.version=c.current_version WHERE c.workspace_id=? AND c.id=? AND c.status='active'",
      )
      .get(workspaceId, id) as Row | undefined;
    return row
      ? {
          credentialId: String(row.credential_id),
          version: Number(row.current_version),
          backend: String(row.backend) as SecretBlob['backend'],
          ciphertext: row.ciphertext as Uint8Array | null,
          nonce: row.nonce as Uint8Array | null,
          authTag: row.auth_tag as Uint8Array | null,
          backendRef: row.backend_ref === null ? null : String(row.backend_ref),
        }
      : undefined;
  }
  credentialReferences(workspaceId: string, id: string, maxIds = 20): CredentialReferences {
    const bounded = Math.max(0, Math.min(100, Math.trunc(maxIds)));
    const providers = this.db
        .prepare(
          'SELECT id FROM provider_bindings WHERE workspace_id=? AND credential_id=? ORDER BY id LIMIT ?',
        )
        .all(workspaceId, id, bounded) as Row[],
      mcp = this.db
        .prepare(
          'SELECT id FROM mcp_connections WHERE workspace_id=? AND credential_id=? ORDER BY id LIMIT ?',
        )
        .all(workspaceId, id, bounded) as Row[],
      providerCount = this.db
        .prepare(
          'SELECT COUNT(*) AS total FROM provider_bindings WHERE workspace_id=? AND credential_id=?',
        )
        .get(workspaceId, id) as Row,
      mcpCount = this.db
        .prepare(
          'SELECT COUNT(*) AS total FROM mcp_connections WHERE workspace_id=? AND credential_id=?',
        )
        .get(workspaceId, id) as Row;
    return {
      providerBindings: {
        total: Number(providerCount.total),
        ids: providers.map((row) => String(row.id)),
      },
      mcpConnections: {
        total: Number(mcpCount.total),
        ids: mcp.map((row) => String(row.id)),
      },
    };
  }
  retireCredential(workspaceId: string, id: string) {
    return transaction(this.db, () => {
      if (!this.getCredential(workspaceId, id)) throw new Error('Credential not found');
      const references = this.credentialReferences(workspaceId, id);
      if (references.providerBindings.total || references.mcpConnections.total)
        throw new ReferencedResourceError('Credential is still referenced.', references);
      this.db
        .prepare(
          "UPDATE credentials SET status='retired',retired_at=? WHERE workspace_id=? AND id=?",
        )
        .run(now(), workspaceId, id);
      return this.getCredential(workspaceId, id)!;
    });
  }
  private mapBinding(row: Row): ProviderBinding {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      label: String(row.label),
      provider: String(row.provider),
      environment: String(row.environment),
      credentialId: String(row.credential_id),
      config: parseObject(row.config_json),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
  createProviderBinding(
    input: Omit<ProviderBinding, 'id' | 'createdAt' | 'updatedAt'> & { id?: string },
  ) {
    const credential = this.getCredential(input.workspaceId, input.credentialId);
    if (!credential || credential.status !== 'active')
      throw new Error('Active credential not found');
    const id = input.id ?? randomUUID(),
      at = now();
    this.db
      .prepare(
        'INSERT INTO provider_bindings(id,workspace_id,label,provider,environment,credential_id,config_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        input.workspaceId,
        input.label,
        input.provider,
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
    },
  ) {
    const credential = this.getCredential(workspaceId, input.credentialId);
    if (!credential || credential.status !== 'active')
      throw new Error('Active credential not found');
    const result = this.db
      .prepare(
        'UPDATE provider_bindings SET label=?,provider=?,environment=?,credential_id=?,config_json=?,updated_at=? WHERE workspace_id=? AND id=?',
      )
      .run(
        input.label,
        input.provider,
        input.environment,
        input.credentialId,
        json(input.config),
        now(),
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
