import { createHash } from 'node:crypto';
import type { CostLedgerService } from '@winsendotai/ovo-plugin-ledger';
import type { Pool, PoolClient } from 'pg';
import { decodeCursor, page, pageLimit } from './helpers.ts';
import {
  providerEvaluationPolicy,
  validateProviderEvaluationPolicy,
  type ProviderEvaluationAuthorization,
  type ProviderEvaluationAuthorizationResolver,
  type ProviderEvaluationReleaseLoader,
} from './provider-policy.ts';
import type { Page } from './types.ts';

type Row = Record<string, unknown>;

export class PostgresProviderEvaluationAuthorizations implements ProviderEvaluationAuthorizationResolver {
  constructor(
    private readonly pool: Pool,
    private readonly ledger: CostLedgerService,
    private readonly releases: ProviderEvaluationReleaseLoader,
  ) {}

  async createForRelease(input: {
    workspaceId: string;
    releaseId: string;
    maximumReservationPaise: string;
    idempotencyKey: string;
    createdBy: string;
  }): Promise<ProviderEvaluationAuthorization> {
    const release = await this.releases.load(input.workspaceId, input.releaseId);
    const binding = release.providerBindings?.inference;
    if (!binding) throw invalid('The immutable release has no inference binding');
    const bindingVersion = `${binding.id}:${binding.updatedAt}`;
    const policy = providerEvaluationPolicy(release, bindingVersion, input.workspaceId);
    await validateProviderEvaluationPolicy(this.ledger, input.workspaceId, policy);
    const maximum = positiveAmount(input.maximumReservationPaise);
    if (BigInt(maximum) < BigInt(policy.reservationPaise))
      throw invalid('Maximum reservation is below the immutable release reservation');
    const authorization: ProviderEvaluationAuthorization = {
      id: authorizationId(input.workspaceId, bounded(input.idempotencyKey, 'idempotencyKey', 200)),
      workspaceId: bounded(input.workspaceId, 'workspaceId', 200),
      releaseId: bounded(input.releaseId, 'releaseId', 200),
      releaseFingerprint: bounded(release.fingerprint, 'releaseFingerprint', 512),
      bindingVersion,
      provider: policy.provider,
      modelId: policy.modelId,
      budgetId: policy.budgetId,
      maximumReservationPaise: maximum,
      createdBy: bounded(input.createdBy, 'createdBy', 200),
      createdAt: new Date().toISOString(),
    };
    const inserted = await this.pool.query<Row>(
      `INSERT INTO ovo_eval_provider_authorizations
       (workspace_id,id,idempotency_key,release_id,release_fingerprint,binding_version,provider,
        model_id,budget_id,maximum_reservation_paise,created_by,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT(workspace_id,idempotency_key) DO NOTHING RETURNING *`,
      [
        authorization.workspaceId,
        authorization.id,
        input.idempotencyKey,
        authorization.releaseId,
        authorization.releaseFingerprint,
        authorization.bindingVersion,
        authorization.provider,
        authorization.modelId,
        authorization.budgetId,
        authorization.maximumReservationPaise,
        authorization.createdBy,
        authorization.createdAt,
      ],
    );
    if (inserted.rowCount) return mapAuthorization(inserted.rows[0]!);
    const existing = await this.findByIdempotency(input.workspaceId, input.idempotencyKey);
    if (!existing || !sameImmutableAuthorization(existing, authorization))
      throw Object.assign(new Error('Provider evaluation authorization idempotency conflict'), {
        statusCode: 409,
        code: 'provider_evaluation_authorization_conflict',
      });
    return existing;
  }

  async get(id: string): Promise<ProviderEvaluationAuthorization | undefined> {
    const result = await this.pool.query<Row>(
      `SELECT * FROM ovo_eval_provider_authorizations
       WHERE id=$1 AND revoked_at IS NULL`,
      [bounded(id, 'id', 200)],
    );
    return result.rowCount ? mapAuthorization(result.rows[0]!) : undefined;
  }

  async withActive<T>(
    id: string,
    operation: (authorization: ProviderEvaluationAuthorization) => Promise<T>,
  ): Promise<T | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<Row>(
        `SELECT * FROM ovo_eval_provider_authorizations
         WHERE id=$1 AND revoked_at IS NULL FOR SHARE`,
        [bounded(id, 'id', 200)],
      );
      if (!result.rowCount) {
        await client.query('COMMIT');
        return undefined;
      }
      const value = await operation(mapAuthorization(result.rows[0]!));
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async list(
    workspaceId: string,
    limit?: number,
    cursor?: string,
  ): Promise<Page<ProviderEvaluationAuthorization>> {
    const size = pageLimit(limit);
    const after = decodeCursor(cursor);
    const result = await this.pool.query<Row>(
      `SELECT * FROM ovo_eval_provider_authorizations
       WHERE workspace_id=$1 AND id>$2 ORDER BY id LIMIT $3`,
      [bounded(workspaceId, 'workspaceId', 200), after, size + 1],
    );
    return page(result.rows.map(mapAuthorization), size, (item) => item.id);
  }

  async revoke(
    workspaceId: string,
    id: string,
    revokedBy: string,
  ): Promise<ProviderEvaluationAuthorization | undefined> {
    const result = await this.pool.query<Row>(
      `UPDATE ovo_eval_provider_authorizations
       SET revoked_at=COALESCE(revoked_at,$1),revoked_by=COALESCE(revoked_by,$2)
       WHERE workspace_id=$3 AND id=$4 RETURNING *`,
      [
        new Date().toISOString(),
        bounded(revokedBy, 'revokedBy', 200),
        bounded(workspaceId, 'workspaceId', 200),
        bounded(id, 'id', 200),
      ],
    );
    return result.rowCount ? mapAuthorization(result.rows[0]!) : undefined;
  }

  private async findByIdempotency(workspaceId: string, key: string) {
    const result = await this.pool.query<Row>(
      `SELECT * FROM ovo_eval_provider_authorizations
       WHERE workspace_id=$1 AND idempotency_key=$2`,
      [workspaceId, key],
    );
    return result.rowCount ? mapAuthorization(result.rows[0]!) : undefined;
  }
}

function mapAuthorization(row: Row): ProviderEvaluationAuthorization {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    releaseId: String(row.release_id),
    releaseFingerprint: String(row.release_fingerprint),
    bindingVersion: String(row.binding_version),
    provider: String(row.provider),
    modelId: String(row.model_id),
    budgetId: String(row.budget_id),
    maximumReservationPaise: String(row.maximum_reservation_paise),
    createdBy: String(row.created_by),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    revokedBy: row.revoked_by ? String(row.revoked_by) : undefined,
    revokedAt: row.revoked_at ? new Date(row.revoked_at as string | Date).toISOString() : undefined,
  };
}

function authorizationId(workspaceId: string, idempotencyKey: string) {
  const digest = createHash('sha256')
    .update(JSON.stringify({ workspaceId, idempotencyKey }))
    .digest('hex');
  return `evalauth_${digest.slice(0, 40)}`;
}

function sameImmutableAuthorization(
  current: ProviderEvaluationAuthorization,
  requested: ProviderEvaluationAuthorization,
) {
  return (
    current.workspaceId === requested.workspaceId &&
    current.releaseId === requested.releaseId &&
    current.releaseFingerprint === requested.releaseFingerprint &&
    current.bindingVersion === requested.bindingVersion &&
    current.provider === requested.provider &&
    current.modelId === requested.modelId &&
    current.budgetId === requested.budgetId &&
    current.maximumReservationPaise === requested.maximumReservationPaise
  );
}

function positiveAmount(value: string) {
  if (!/^[1-9][0-9]{0,59}$/.test(value)) throw invalid('maximumReservationPaise is invalid');
  return value;
}

function bounded(value: string, name: string, maximum: number) {
  if (!value.trim() || value.length > maximum) throw new TypeError(`${name} is invalid`);
  return value;
}

function invalid(message: string) {
  return Object.assign(new Error(message), {
    statusCode: 400,
    code: 'provider_evaluation_authorization_invalid',
  });
}
