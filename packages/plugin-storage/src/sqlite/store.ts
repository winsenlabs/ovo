import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { OperationRecord, OperationStore } from '@winsendotai/ovo-contracts';
import type { ControlStore } from '../models.ts';
import { AgentsRepository } from './agents-repository.ts';
import { InspectionRepository } from './inspection-repository.ts';
import { McpRepository } from './mcp-repository.ts';
import { migrate } from './migrations.ts';
import { SecretsRepository } from './secrets-repository.ts';
import { json, now, type Row } from './shared.ts';

function bindRepository(target: object, repository: object) {
  for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(repository))) {
    if (key === 'constructor' || typeof (repository as Record<string, unknown>)[key] !== 'function')
      continue;
    Object.defineProperty(target, key, {
      value: (repository as Record<string, Function>)[key]!.bind(repository),
      enumerable: false,
    });
  }
}

export interface NodeSqliteControlStore extends ControlStore {}
/** Single-process development adapter. Production Fargate requires a PostgreSQL ControlStore. */
export class NodeSqliteControlStore {
  private readonly database: DatabaseSync;
  readonly operationStore: OperationStore;
  constructor(readonly filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.database = new DatabaseSync(filename);
    this.database.exec(
      'PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;',
    );
    migrate(this.database);
    const agents = new AgentsRepository(this.database),
      secrets = new SecretsRepository(this.database);
    const mcp = new McpRepository(
      this.database,
      secrets.getCredential.bind(secrets),
      agents.getAgent.bind(agents),
    );
    bindRepository(this, agents);
    bindRepository(this, secrets);
    bindRepository(this, mcp);
    bindRepository(this, new InspectionRepository(this.database));
    this.operationStore = this.createOperationStore();
  }
  private createOperationStore(): OperationStore {
    return {
      createIntent: async (record: OperationRecord) => {
        if (record.state !== 'intent') throw new Error('Operation must begin as intent');
        const result = this.database
          .prepare(
            'INSERT OR IGNORE INTO operations(workspace_id,id,record_json,updated_at) VALUES(?,?,?,?)',
          )
          .run(record.workspaceId, record.id, json(record), now());
        return result.changes === 1;
      },
      get: async (workspaceId: string, id: string) => {
        const row = this.database
          .prepare('SELECT record_json FROM operations WHERE workspace_id=? AND id=?')
          .get(workspaceId, id) as Row | undefined;
        return row ? (JSON.parse(String(row.record_json)) as OperationRecord) : undefined;
      },
      settle: async (record: OperationRecord) => {
        const result = this.database
          .prepare('UPDATE operations SET record_json=?,updated_at=? WHERE workspace_id=? AND id=?')
          .run(json(record), now(), record.workspaceId, record.id);
        if (!result.changes) throw new Error('Operation intent not found');
      },
    };
  }
  close() {
    this.database.close();
  }
}
