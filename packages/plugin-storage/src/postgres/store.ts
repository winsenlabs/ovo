import type { PoolConfig } from 'pg';
import pg from 'pg';
import type { ControlStore } from '../control-store.ts';
import { PostgresAgentsRepository } from './agents-repository.ts';
import { PostgresBindingsRepository } from './bindings-repository.ts';
import { PostgresCallsRepository } from './calls-repository.ts';
import { PostgresInspectionRepository } from './inspection-repository.ts';
import { PostgresMcpRepository } from './mcp-repository.ts';
import { runControlMigrations } from './migrations.ts';
import { PostgresOperationStore } from './operation-store.ts';
import { PostgresReleasesRepository } from './releases-repository.ts';
import { PostgresSecretsRepository } from './secrets-repository.ts';

function bindRepository(target: object, repository: object) {
  for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(repository))) {
    if (key === 'constructor' || typeof (repository as Record<string, unknown>)[key] !== 'function')
      continue;
    Object.defineProperty(target, key, {
      value: (repository as Record<string, (...args: unknown[]) => unknown>)[key]!.bind(repository),
      enumerable: false,
    });
  }
}

export interface PostgresControlStore extends ControlStore {}

export class PostgresControlStore {
  private readonly pool: pg.Pool;
  readonly operationStore: PostgresOperationStore;

  private constructor(config: PoolConfig) {
    this.pool = new pg.Pool(config);
    this.operationStore = new PostgresOperationStore(this.pool);
    bindRepository(this, new PostgresAgentsRepository(this.pool));
    bindRepository(this, new PostgresReleasesRepository(this.pool));
    bindRepository(this, new PostgresSecretsRepository(this.pool));
    bindRepository(this, new PostgresBindingsRepository(this.pool));
    bindRepository(this, new PostgresMcpRepository(this.pool));
    bindRepository(this, new PostgresCallsRepository(this.pool));
    bindRepository(this, new PostgresInspectionRepository(this.pool));
  }

  static async open(config: string | PoolConfig) {
    const store = new PostgresControlStore(
      typeof config === 'string' ? { connectionString: config } : config,
    );
    try {
      await runControlMigrations(store.pool);
      return store;
    } catch (error) {
      await store.pool.end().catch(() => undefined);
      throw error;
    }
  }

  async close() {
    await this.pool.end();
  }
}
