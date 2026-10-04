import { spawnSync } from 'node:child_process';

export function isolatedPostgres(baseConnectionUrl, label) {
  if (!baseConnectionUrl) return { env: process.env, close: () => undefined };
  const base = new URL(baseConnectionUrl);
  const databaseName = `ovo_mut_${process.pid}_${label}`;
  const adminEnv = {
    ...process.env,
    PGHOST: base.hostname,
    PGPORT: base.port || '5432',
    PGUSER: decodeURIComponent(base.username),
    PGPASSWORD: decodeURIComponent(base.password),
    PGDATABASE: decodeURIComponent(base.pathname.slice(1)),
  };
  function psql(sql) {
    const result = spawnSync('psql', ['-v', 'ON_ERROR_STOP=1', '-c', sql], {
      encoding: 'utf8',
      env: adminEnv,
      timeout: 30_000,
    });
    if (result.status !== 0)
      throw new Error(`Postgres isolation failed: ${result.stderr || result.stdout}`);
  }
  psql(`CREATE DATABASE ${databaseName}`);
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return {
    env: {
      ...process.env,
      OVO_TEST_POSTGRES_URL: url.toString(),
      RECORDING_TEST_DATABASE_URL: url.toString(),
    },
    close: () => psql(`DROP DATABASE ${databaseName} WITH (FORCE)`),
  };
}
