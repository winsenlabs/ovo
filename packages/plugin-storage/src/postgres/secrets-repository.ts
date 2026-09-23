import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  ReferencedResourceError,
  type CredentialMetadata,
  type CredentialReferences,
  type ProviderBinding,
  type SecretBlob,
} from '../models.ts';
import {
  decodeCursor,
  now,
  pageFromRows,
  pageLimit,
  type Queryable,
  type Row,
  toIso,
  transaction,
} from './shared.ts';

export class PostgresSecretsRepository {
  constructor(private readonly pool: Pool) {}

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
      permittedAgentIds: row.permitted_agent_ids as string[],
      expiresAt: row.expires_at === null ? null : toIso(row.expires_at),
      createdBy: String(row.created_by),
      createdAt: toIso(row.created_at),
      rotatedAt: row.rotated_at === null ? null : toIso(row.rotated_at),
      retiredAt: row.retired_at === null ? null : toIso(row.retired_at),
      fingerprint: String(row.fingerprint),
    };
  }

  async createCredential(input: {
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
    return transaction(this.pool, async (client) => {
      const id = input.id ?? randomUUID(),
        at = now();
      const result = await client.query<Row>(
        `INSERT INTO ovo_ctl_credentials
         (workspace_id,id,label,provider,type,environment,backend,current_version,status,
          permitted_agent_ids,expires_at,created_by,created_at,fingerprint)
         VALUES($1,$2,$3,$4,$5,$6,$7,1,'active',$8,$9,$10,$11,$12) RETURNING *`,
        [
          input.workspaceId,
          id,
          input.label,
          input.provider,
          input.type,
          input.environment,
          input.backend,
          JSON.stringify(input.permittedAgentIds),
          input.expiresAt ?? null,
          input.createdBy,
          at,
          input.fingerprint,
        ],
      );
      await this.insertSecret(client, input.workspaceId, id, 1, input.backend, input.secret, at);
      return this.mapCredential(result.rows[0]!);
    });
  }

  private async insertSecret(
    query: Queryable,
    workspaceId: string,
    id: string,
    version: number,
    backend: CredentialMetadata['backend'],
    secret: Omit<SecretBlob, 'credentialId' | 'version' | 'backend'>,
    at: string,
  ) {
    await query.query(
      `INSERT INTO ovo_ctl_secret_versions
       (workspace_id,credential_id,version,backend,ciphertext,nonce,auth_tag,backend_ref,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        workspaceId,
        id,
        version,
        backend,
        secret.ciphertext,
        secret.nonce,
        secret.authTag,
        secret.backendRef,
        at,
      ],
    );
  }

  async rotateCredential(
    workspaceId: string,
    id: string,
    input: {
      fingerprint: string;
      secret: Omit<SecretBlob, 'credentialId' | 'version' | 'backend'>;
    },
  ) {
    return transaction(this.pool, async (client) => {
      const locked = await client.query<Row>(
        `SELECT * FROM ovo_ctl_credentials
         WHERE workspace_id=$1 AND id=$2 AND status='active' FOR UPDATE`,
        [workspaceId, id],
      );
      if (!locked.rowCount) throw new Error('Active credential not found');
      const current = this.mapCredential(locked.rows[0]!),
        version = current.currentVersion + 1,
        at = now();
      await this.insertSecret(client, workspaceId, id, version, current.backend, input.secret, at);
      const result = await client.query<Row>(
        `UPDATE ovo_ctl_credentials SET current_version=$1,rotated_at=$2,fingerprint=$3
         WHERE workspace_id=$4 AND id=$5 RETURNING *`,
        [version, at, input.fingerprint, workspaceId, id],
      );
      return this.mapCredential(result.rows[0]!);
    });
  }

  async getCredential(workspaceId: string, id: string, query: Queryable = this.pool) {
    const result = await query.query<Row>(
      'SELECT * FROM ovo_ctl_credentials WHERE workspace_id=$1 AND id=$2',
      [workspaceId, id],
    );
    return result.rowCount ? this.mapCredential(result.rows[0]!) : undefined;
  }

  async listCredentials(workspaceId: string, limit = 50, cursor?: string) {
    const size = pageLimit(limit),
      after = decodeCursor(cursor);
    const result = await this.pool.query<Row>(
      `SELECT * FROM ovo_ctl_credentials WHERE workspace_id=$1
       AND ($2::timestamptz IS NULL OR (created_at,id) > ($2::timestamptz,$3::text))
       ORDER BY created_at,id LIMIT $4`,
      [workspaceId, after?.at ?? null, after?.id ?? '', size + 1],
    );
    return pageFromRows(result.rows, size, (row) => this.mapCredential(row));
  }

  async getActiveSecretBlob(workspaceId: string, id: string): Promise<SecretBlob | undefined> {
    const result = await this.pool.query<Row>(
      `SELECT c.id AS credential_id,c.current_version,c.backend,s.ciphertext,s.nonce,
              s.auth_tag,s.backend_ref
       FROM ovo_ctl_credentials c JOIN ovo_ctl_secret_versions s
         ON s.workspace_id=c.workspace_id AND s.credential_id=c.id AND s.version=c.current_version
       WHERE c.workspace_id=$1 AND c.id=$2 AND c.status='active'`,
      [workspaceId, id],
    );
    if (!result.rowCount) return undefined;
    const row = result.rows[0]!;
    return {
      credentialId: String(row.credential_id),
      version: Number(row.current_version),
      backend: String(row.backend) as SecretBlob['backend'],
      ciphertext: (row.ciphertext as Uint8Array | null) ?? null,
      nonce: (row.nonce as Uint8Array | null) ?? null,
      authTag: (row.auth_tag as Uint8Array | null) ?? null,
      backendRef: row.backend_ref === null ? null : String(row.backend_ref),
    };
  }

  async credentialReferences(
    workspaceId: string,
    id: string,
    maxIds = 20,
    query: Queryable = this.pool,
  ): Promise<CredentialReferences> {
    const size = Math.max(0, Math.min(100, Math.trunc(maxIds)));
    const [providers, mcp, providerCount, mcpCount] = await Promise.all([
      query.query<Row>(
        `SELECT id FROM ovo_ctl_provider_bindings
         WHERE workspace_id=$1 AND credential_id=$2 ORDER BY id LIMIT $3`,
        [workspaceId, id, size],
      ),
      query.query<Row>(
        `SELECT id FROM ovo_ctl_mcp_connections
         WHERE workspace_id=$1 AND credential_id=$2 ORDER BY id LIMIT $3`,
        [workspaceId, id, size],
      ),
      query.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM ovo_ctl_provider_bindings
         WHERE workspace_id=$1 AND credential_id=$2`,
        [workspaceId, id],
      ),
      query.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM ovo_ctl_mcp_connections
         WHERE workspace_id=$1 AND credential_id=$2`,
        [workspaceId, id],
      ),
    ]);
    return {
      providerBindings: {
        total: Number(providerCount.rows[0]!.total),
        ids: providers.rows.map((row) => String(row.id)),
      },
      mcpConnections: {
        total: Number(mcpCount.rows[0]!.total),
        ids: mcp.rows.map((row) => String(row.id)),
      },
    };
  }

  async retireCredential(workspaceId: string, id: string) {
    return transaction(this.pool, async (client) => {
      const locked = await client.query<Row>(
        'SELECT * FROM ovo_ctl_credentials WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
        [workspaceId, id],
      );
      if (!locked.rowCount) throw new Error('Credential not found');
      const references = await this.credentialReferences(workspaceId, id, 20, client);
      if (references.providerBindings.total || references.mcpConnections.total)
        throw new ReferencedResourceError('Credential is still referenced.', references);
      const result = await client.query<Row>(
        `UPDATE ovo_ctl_credentials SET status='retired',retired_at=$1
         WHERE workspace_id=$2 AND id=$3 RETURNING *`,
        [now(), workspaceId, id],
      );
      return this.mapCredential(result.rows[0]!);
    });
  }
}
