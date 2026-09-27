import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import { NodeSqliteControlStore, PostgresControlStore, type ControlStore } from '../src/index.ts';
import type { PostgresCallsRepository } from '../src/postgres/calls-repository.ts';
import type { PostgresReleasesRepository } from '../src/postgres/releases-repository.ts';

type FixtureStore = ControlStore &
  Pick<PostgresCallsRepository, 'createFixtureCall'> &
  Pick<PostgresReleasesRepository, 'getFixtureCallRelease'>;
export const databaseUrl = process.env.OVO_TEST_POSTGRES_URL;
export const config = (message = 'Unpublished draft') =>
  AgentConfig.parse({ name: 'Draft fixture', mode: 'announcement', message, recording: false });
export async function open(backend: string) {
  const folder = mkdtempSync(join(tmpdir(), 'ovo-fixture-admission-'));
  const schema = `fixture_${randomUUID().replaceAll('-', '')}`;
  const root = backend === 'postgres' ? new pg.Pool({ connectionString: databaseUrl }) : undefined;
  await root?.query(`CREATE SCHEMA ${schema}`);
  const options = { connectionString: databaseUrl, options: `-c search_path=${schema}` };
  const file = join(folder, 'control.sqlite');
  const load = () =>
    backend === 'postgres'
      ? PostgresControlStore.open(options)
      : Promise.resolve(new NodeSqliteControlStore(file));
  const store = (await load()) as unknown as FixtureStore,
    peer = (await load()) as unknown as FixtureStore;
  const db = backend === 'sqlite' ? new DatabaseSync(file) : undefined;
  const pool = root ? new pg.Pool(options) : undefined;
  return {
    store,
    peer,
    async sql(sqlite: string, postgres = sqlite) {
      if (pool) await pool.query(postgres);
      else db!.exec(sqlite);
    },
    async remigrate() {
      const next = await load();
      await next.close();
    },
    async versions() {
      if (pool)
        return (
          await pool.query('SELECT version FROM ovo_control_schema_migrations ORDER BY version')
        ).rows.map((row) => Number(row.version));
      return db!
        .prepare('SELECT version FROM ovo_control_schema_migrations ORDER BY version')
        .all()
        .map((row) => Number(row.version));
    },
    async count(table: 'releases' | 'calls' | 'call_events') {
      if (pool)
        return Number(
          (await pool.query(`SELECT count(*) AS count FROM ovo_ctl_${table}`)).rows[0].count,
        );
      return Number(db!.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count);
    },
    async close() {
      await store.close();
      await peer.close();
      db?.close();
      await pool?.end();
      await root?.query(`DROP SCHEMA ${schema} CASCADE`);
      await root?.end();
      rmSync(folder, { recursive: true, force: true });
    },
  };
}
