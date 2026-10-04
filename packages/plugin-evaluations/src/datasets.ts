import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { decodeCursor, page, pageLimit } from './helpers.ts';
import type { DatasetRecord, DatasetVersionRecord, Page } from './types.ts';
import { datasetFingerprint, validateCases } from './validation.ts';

type Row = Record<string, unknown>;
const iso = (value: unknown) => new Date(value as string | Date).toISOString();

export class EvaluationDatasets {
  constructor(private readonly pool: Pool) {}

  async create(input: {
    workspaceId: string;
    id?: string;
    name: string;
    description?: string;
  }): Promise<DatasetRecord> {
    const id = input.id ?? randomUUID(),
      now = new Date().toISOString();
    const result = await this.pool.query<Row>(
      `INSERT INTO ovo_eval_datasets
       (workspace_id,id,name,description,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5) RETURNING *`,
      [
        input.workspaceId,
        id,
        bounded(input.name, 'name', 200),
        bounded(input.description ?? '', 'description', 2_000, true),
        now,
      ],
    );
    return mapDataset(result.rows[0]!);
  }

  async get(workspaceId: string, id: string): Promise<DatasetRecord | undefined> {
    const result = await this.pool.query<Row>(
      'SELECT * FROM ovo_eval_datasets WHERE workspace_id=$1 AND id=$2',
      [workspaceId, id],
    );
    return result.rowCount ? mapDataset(result.rows[0]!) : undefined;
  }

  async list(workspaceId: string, limit?: number, cursor?: string): Promise<Page<DatasetRecord>> {
    const size = pageLimit(limit),
      after = decodeCursor(cursor);
    const result = await this.pool.query<Row>(
      `SELECT * FROM ovo_eval_datasets WHERE workspace_id=$1 AND id>$2
       ORDER BY id LIMIT $3`,
      [workspaceId, after, size + 1],
    );
    return page(result.rows.map(mapDataset), size, (item) => item.id);
  }

  async update(
    workspaceId: string,
    id: string,
    input: { name: string; description?: string },
  ): Promise<DatasetRecord | undefined> {
    const result = await this.pool.query<Row>(
      `UPDATE ovo_eval_datasets SET name=$1,description=$2,updated_at=$3
       WHERE workspace_id=$4 AND id=$5 AND archived_at IS NULL RETURNING *`,
      [
        bounded(input.name, 'name', 200),
        bounded(input.description ?? '', 'description', 2_000, true),
        new Date().toISOString(),
        workspaceId,
        id,
      ],
    );
    return result.rowCount ? mapDataset(result.rows[0]!) : undefined;
  }

  async archive(workspaceId: string, id: string): Promise<boolean> {
    const now = new Date().toISOString();
    const result = await this.pool.query(
      `UPDATE ovo_eval_datasets SET archived_at=COALESCE(archived_at,$1),updated_at=$1
       WHERE workspace_id=$2 AND id=$3`,
      [now, workspaceId, id],
    );
    return Boolean(result.rowCount);
  }

  async remove(workspaceId: string, id: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const used = await client.query(
        'SELECT 1 FROM ovo_eval_runs WHERE workspace_id=$1 AND dataset_id=$2 LIMIT 1',
        [workspaceId, id],
      );
      if (used.rowCount)
        throw Object.assign(new Error('Dataset has evaluation runs'), { statusCode: 409 });
      await client.query(
        'DELETE FROM ovo_eval_dataset_versions WHERE workspace_id=$1 AND dataset_id=$2',
        [workspaceId, id],
      );
      const deleted = await client.query(
        'DELETE FROM ovo_eval_datasets WHERE workspace_id=$1 AND id=$2',
        [workspaceId, id],
      );
      await client.query('COMMIT');
      return Boolean(deleted.rowCount);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async importVersion(input: {
    workspaceId: string;
    datasetId: string;
    cases: unknown;
    createdBy: string;
  }): Promise<DatasetVersionRecord> {
    const cases = validateCases(input.cases),
      fingerprint = datasetFingerprint(cases),
      client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const dataset = await client.query<Row>(
        `SELECT * FROM ovo_eval_datasets WHERE workspace_id=$1 AND id=$2
         AND archived_at IS NULL FOR UPDATE`,
        [input.workspaceId, input.datasetId],
      );
      if (!dataset.rowCount)
        throw Object.assign(new Error('Dataset not found'), { statusCode: 404 });
      const existing = await client.query<Row>(
        `SELECT * FROM ovo_eval_dataset_versions
         WHERE workspace_id=$1 AND dataset_id=$2 AND fingerprint=$3`,
        [input.workspaceId, input.datasetId, fingerprint],
      );
      if (existing.rowCount) {
        await client.query('COMMIT');
        return mapVersion(existing.rows[0]!);
      }
      const version = Number(dataset.rows[0]!.current_version) + 1,
        now = new Date().toISOString();
      const inserted = await client.query<Row>(
        `INSERT INTO ovo_eval_dataset_versions
         (workspace_id,dataset_id,version,fingerprint,cases,created_at,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [
          input.workspaceId,
          input.datasetId,
          version,
          fingerprint,
          JSON.stringify(cases),
          now,
          input.createdBy,
        ],
      );
      await client.query(
        `UPDATE ovo_eval_datasets SET current_version=$1,updated_at=$2
         WHERE workspace_id=$3 AND id=$4`,
        [version, now, input.workspaceId, input.datasetId],
      );
      await client.query('COMMIT');
      return mapVersion(inserted.rows[0]!);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getVersion(workspaceId: string, datasetId: string, version: number) {
    const result = await this.pool.query<Row>(
      `SELECT * FROM ovo_eval_dataset_versions
       WHERE workspace_id=$1 AND dataset_id=$2 AND version=$3`,
      [workspaceId, datasetId, version],
    );
    return result.rowCount ? mapVersion(result.rows[0]!) : undefined;
  }

  async listVersions(workspaceId: string, datasetId: string, limit?: number, cursor?: string) {
    const size = pageLimit(limit),
      after = Number(decodeCursor(cursor) || 0);
    if (!Number.isInteger(after) || after < 0)
      throw Object.assign(new Error('Invalid cursor'), { statusCode: 400 });
    const result = await this.pool.query<Row>(
      `SELECT * FROM ovo_eval_dataset_versions
       WHERE workspace_id=$1 AND dataset_id=$2 AND version>$3 ORDER BY version LIMIT $4`,
      [workspaceId, datasetId, after, size + 1],
    );
    return page(result.rows.map(mapVersion), size, (item) => String(item.version));
  }
}

function mapDataset(row: Row): DatasetRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    name: String(row.name),
    description: String(row.description),
    currentVersion: Number(row.current_version),
    archivedAt: row.archived_at ? iso(row.archived_at) : undefined,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
function mapVersion(row: Row): DatasetVersionRecord {
  return {
    datasetId: String(row.dataset_id),
    workspaceId: String(row.workspace_id),
    version: Number(row.version),
    fingerprint: String(row.fingerprint),
    cases: structuredClone(row.cases) as DatasetVersionRecord['cases'],
    createdAt: iso(row.created_at),
    createdBy: String(row.created_by),
  };
}
function bounded(value: string, name: string, max: number, empty = false) {
  if ((!empty && !value.trim()) || value.length > max) throw new TypeError(`${name} is invalid`);
  return value;
}
