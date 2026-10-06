// OPS-12: ovo-backup.sh, ovo-restore.sh and restore-drill.sh. The PostgreSQL round trip runs against
// OVO_TEST_POSTGRES_URL with the host's pg_dump/pg_restore in scratch databases; `gcloud storage`
// and `age` are local stand-ins (fake-tools.mjs), so nothing reaches GCS and nothing is encrypted.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ROOT, runScript, sandbox } from '../../ops/tests/fake-stack.ts';

const POSTGRES = process.env.OVO_TEST_POSTGRES_URL;
const hasClient = (() => {
  try {
    execFileSync('pg_dump', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function tools() {
  const box = sandbox();
  cleanups.push(box.cleanup);
  const bin = join(box.dir, 'bin');
  for (const tool of ['gcloud', 'age']) {
    writeFileSync(
      join(bin, tool),
      `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, 'scripts/backup/tests/fake-tools.mjs')}" ${tool} "$@"\n`,
    );
    chmodSync(join(bin, tool), 0o755);
  }
  const gcs = join(box.dir, 'gcs');
  const log = join(box.dir, 'tools.log');
  writeFileSync(log, '');
  const envFile = join(box.dir, '.env');
  writeFileSync(
    envFile,
    'COMPOSE_PROFILES=local-queue\nDATABASE_URL=postgresql://ovo:live-secret@db.internal:5432/ovo\nOVO_SECRETS_MASTER_KEY=master-key-hex\n',
    { mode: 0o600 },
  );
  const opsFile = join(box.dir, '.env.ops');
  const local = join(box.dir, 'local');
  writeFileSync(
    opsFile,
    `OVO_OPS_BACKUP_BUCKET=gs://ovo-backups\nOVO_OPS_BACKUP_AGE_RECIPIENT=age1testrecipient\nOVO_OPS_BACKUP_LOCAL_DIR=${local}\nOVO_OPS_BACKUP_KEEP_LOCAL=2\n`,
  );
  const env = { ...box.env, FAKE_GCS_ROOT: gcs, FAKE_TOOLS_LOG: log };
  const files = ['--env-file', envFile, '--ops-env', opsFile];
  const toolLog = () => readFileSync(log, 'utf8');
  return { box, env, files, gcs, local, envFile, toolLog };
}

describe('ovo-backup.sh guards', () => {
  it('refuses to upload an unencrypted archive that holds the master key', async () => {
    const { env, files } = tools();
    const run = await runScript('scripts/backup/ovo-backup.sh', [...files, '--no-encrypt'], env);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('refusing to upload an unencrypted archive');
  });

  it('needs an age recipient and a gs:// bucket', async () => {
    const { env, envFile } = tools();
    const run = await runScript(
      'scripts/backup/ovo-backup.sh',
      ['--env-file', envFile, '--ops-env', '/nonexistent'],
      env,
    );
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('OVO_OPS_BACKUP_BUCKET must be gs://');
  });

  it('--dry-run prints the plan and dumps nothing', async () => {
    const { env, files, local, box } = tools();
    const run = await runScript('scripts/backup/ovo-backup.sh', [...files, '--dry-run'], env);
    expect(run.code).toBe(0);
    expect(run.stderr).toMatch(
      /upload to gs:\/\/ovo-backups\/postgres\/\d{4}\/\d{2}\/ovo-\d{8}T\d{6}Z\.tar\.age/,
    );
    expect(existsSync(local)).toBe(false);
    expect(box.dockerLog()).toEqual([]);
  });

  it('picks the bundled postgres container when the local-postgres profile is on', async () => {
    const { env, files, envFile } = tools();
    writeFileSync(envFile, 'COMPOSE_PROFILES=local-postgres,local-queue\n', { mode: 0o600 });
    const run = await runScript('scripts/backup/ovo-backup.sh', [...files, '--dry-run'], env);
    expect(run.stderr).toContain('pg_dump (compose)');
  });
});

describe.skipIf(!POSTGRES || !hasClient)(
  'backup, restore and drill round trip (PostgreSQL)',
  () => {
    const id = `${process.pid}_${Date.now()}`;
    const names = { source: `ovo_bk_src_${id}`, target: `ovo_bk_dst_${id}` };
    const urlFor = (database: string) => {
      const url = new URL(POSTGRES!);
      url.pathname = `/${database}`;
      return url.href;
    };
    const psql = (url: string, sql: string) =>
      execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-qAt', '-c', sql], {
        encoding: 'utf8',
      }).trim();
    let heartbeats = 0;
    const heartbeat = createServer((_request, response) => {
      heartbeats += 1;
      response.end('ok');
    });

    beforeAll(async () => {
      for (const name of Object.values(names)) psql(POSTGRES!, `CREATE DATABASE ${name}`);
      psql(
        urlFor(names.source),
        "CREATE TABLE ovo_ctl_things (id int primary key, label text); INSERT INTO ovo_ctl_things SELECT g, 'thing ' || g FROM generate_series(1, 25) g; CREATE TABLE ovo_jobs_like (id int); INSERT INTO ovo_jobs_like VALUES (1), (2); CREATE TABLE other_table (id int); CREATE TABLE ovo_team_users (email text, disabled boolean, restore_quarantined boolean, session_version int, updated_at timestamptz); INSERT INTO ovo_team_users VALUES ('a@ovo.test', false, false, 1, now())",
      );
      await new Promise<void>((resolve) => heartbeat.listen(0, '127.0.0.1', resolve));
    });
    afterAll(async () => {
      for (const name of Object.values(names))
        psql(POSTGRES!, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await new Promise((resolve) => heartbeat.close(resolve));
    });

    it('dumps, seals, uploads and mirrors, then restores the same rows elsewhere', async () => {
      const { env, files, gcs, local, toolLog, box } = tools();
      const recordings = join(box.dir, 'recordings');
      mkdirSync(join(recordings, 'org'), { recursive: true });
      writeFileSync(join(recordings, 'org', 'call-1.wav'), 'RIFF');
      const backupEnv = {
        ...env,
        OVO_OPS_BACKUP_DATABASE_URL: urlFor(names.source),
        OVO_OPS_BACKUP_RECORDINGS_DIR: recordings,
        OVO_OPS_BACKUP_HEARTBEAT_URL: `http://127.0.0.1:${(heartbeat.address() as AddressInfo).port}/ping`,
      };
      const run = await runScript('scripts/backup/ovo-backup.sh', files, backupEnv);
      expect(run.stderr).not.toContain('error:');
      expect(run.code).toBe(0);
      const summary = JSON.parse(run.stdout.trim().split('\n').at(-1)!);
      expect(summary.remote).toMatch(
        /^gs:\/\/ovo-backups\/postgres\/\d{4}\/\d{2}\/ovo-\d{8}T\d{6}Z\.tar\.age$/,
      );
      expect(existsSync(join(gcs, summary.remote.slice(5)))).toBe(true);
      expect(readFileSync(join(gcs, 'ovo-backups/recordings/org/call-1.wav'), 'utf8')).toBe('RIFF');
      expect(statSync(summary.archive).mode & 0o777).toBe(0o600);
      expect(toolLog()).toContain('age -r age1testrecipient');
      expect(heartbeats).toBe(1);
      // The database password never reaches a command line.
      expect(`${toolLog()}${run.stdout}${run.stderr}`).not.toContain(
        new URL(POSTGRES!).password || 'live-secret',
      );

      const extracted = join(box.dir, 'extracted');
      const extract = await runScript(
        'scripts/backup/ovo-restore.sh',
        ['--archive', summary.remote, '--identity', '/dev/null', '--extract-to', extracted],
        env,
      );
      expect(extract.code).toBe(0);
      expect(readFileSync(join(extracted, 'compose.env'), 'utf8')).toContain(
        'OVO_SECRETS_MASTER_KEY=master-key-hex',
      );
      expect(readFileSync(join(extracted, 'counts.tsv'), 'utf8')).toBe(
        'ovo_ctl_things\t25\novo_jobs_like\t2\novo_team_users\t1\n',
      );

      const restore = await runScript(
        'scripts/backup/ovo-restore.sh',
        ['--archive', summary.remote, '--identity', '/dev/null', '--yes'],
        { ...env, OVO_RESTORE_TARGET_URL: urlFor(names.target) },
      );
      expect(restore.stderr).not.toContain('error:');
      expect(restore.code).toBe(0);
      expect(JSON.parse(restore.stdout.trim()).count_differences).toBe('');
      expect(psql(urlFor(names.target), 'SELECT count(*) FROM ovo_ctl_things')).toBe('25');

      // Local retention keeps the newest two archives.
      for (let i = 0; i < 2; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 1100)).then(() =>
          runScript('scripts/backup/ovo-backup.sh', files, backupEnv),
        );
      expect(readdirSync(local).filter((name) => name.startsWith('ovo-'))).toHaveLength(2);
    });

    it('applies the ownership fence and refuses the live database', async () => {
      const { env, files, envFile } = tools();
      const backup = await runScript(
        'scripts/backup/ovo-backup.sh',
        [...files, '--skip-upload', '--skip-recordings'],
        {
          ...env,
          OVO_OPS_BACKUP_DATABASE_URL: urlFor(names.source),
        },
      );
      const archive = JSON.parse(backup.stdout.trim().split('\n').at(-1)!).archive as string;
      const target = { ...env, OVO_RESTORE_TARGET_URL: urlFor(names.target) };
      const unconfirmed = await runScript(
        'scripts/backup/ovo-restore.sh',
        ['--archive', archive, '--identity', '/dev/null'],
        target,
      );
      expect(unconfirmed.stderr).toContain('pass --yes');
      const fenced = await runScript(
        'scripts/backup/ovo-restore.sh',
        ['--archive', archive, '--identity', '/dev/null', '--yes'],
        target,
      );
      expect(fenced.code).toBe(0);
      // Every restored team user is quarantined, as docs/runbooks/backup-restore.md requires.
      expect(
        psql(
          urlFor(names.target),
          'SELECT disabled, restore_quarantined, session_version FROM ovo_team_users',
        ),
      ).toBe('t|t|2');
      expect(psql(urlFor(names.source), 'SELECT disabled FROM ovo_team_users')).toBe('f');
      const live = await runScript(
        'scripts/backup/ovo-restore.sh',
        ['--archive', archive, '--identity', '/dev/null', '--yes', '--env-file', envFile],
        { ...env, OVO_RESTORE_TARGET_URL: 'postgresql://ovo:live-secret@db.internal:5432/ovo' },
      );
      expect(live.stderr).toContain('refusing to restore over the live DATABASE_URL');
    });

    it('drills the newest offsite archive into a scratch database and drops it', async () => {
      const { env, files } = tools();
      await runScript('scripts/backup/ovo-backup.sh', [...files, '--skip-recordings'], {
        ...env,
        OVO_OPS_BACKUP_DATABASE_URL: urlFor(names.source),
      });
      const drill = await runScript(
        'scripts/backup/restore-drill.sh',
        [...files, '--identity', '/dev/null'],
        {
          ...env,
          OVO_DRILL_SERVER_URL: POSTGRES!,
        },
      );
      expect(drill.stderr).not.toContain('error:');
      expect(drill.code).toBe(0);
      const report = JSON.parse(drill.stdout.trim().split('\n').at(-1)!);
      expect(report).toMatchObject({
        operation: 'restore-drill',
        fresh: true,
        archive_age_hours: 0,
        kept: false,
      });
      expect(
        psql(
          POSTGRES!,
          "SELECT count(*) FROM pg_database WHERE datname LIKE 'ovo_restore_drill_%'",
        ),
      ).toBe('0');
      const stale = await runScript(
        'scripts/backup/restore-drill.sh',
        [...files, '--identity', '/dev/null', '--max-age-hours', '-1'],
        {
          ...env,
          OVO_DRILL_SERVER_URL: POSTGRES!,
        },
      );
      expect(stale.code).not.toBe(0);
      expect(stale.stderr).toContain('check ovo-backup.timer');
    });
  },
);
