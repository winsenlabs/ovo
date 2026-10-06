// scripts/deploy/deploy-compose.sh and build-images.sh against a scratch git repository holding
// copies of the deploy scripts and the stand-in docker: every Compose command is recorded, none runs.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ROOT, runScript, sandbox } from '../../ops/tests/fake-stack.ts';

const COPIED = [
  'scripts/deploy',
  'scripts/ops',
  'scripts/bootstrap-compose.sh',
  'scripts/verify-compose.sh',
  'infra/compose/compose.yaml',
  'infra/compose/.gitignore',
  'infra/caddy',
  'infra/container',
];
const DIGEST = (c: string) => `sha256:${c.repeat(64)}`;

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function git(repo: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd: repo,
    encoding: 'utf8',
  }).trim();
}

function fixture(dockerState: Record<string, unknown> = {}) {
  const box = sandbox({ workers: { 'worker-1': 'ready', 'worker-2': 'ready' }, ...dockerState });
  cleanups.push(box.cleanup);
  const repo = join(box.dir, 'repo');
  for (const path of COPIED) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    cpSync(join(ROOT, path), join(repo, path), {
      recursive: true,
      filter: (source) => !source.includes('/tests'),
    });
  }
  writeFileSync(join(repo, '.gitignore'), '.env*\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'A');
  const first = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'RELEASE'), 'B\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'B');
  const second = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', '--detach', first);
  git(repo, 'remote', 'add', 'origin', repo);
  const envFile = join(repo, 'infra/compose/.env');
  execFileSync('bash', [join(repo, 'scripts/bootstrap-compose.sh')], {
    env: { ...process.env, OVO_SEED_ADMIN_EMAIL: 'admin@ovo.test' },
    stdio: 'pipe',
  });
  const deploy = (...args: string[]) =>
    runScript(
      join(repo, 'scripts/deploy/deploy-compose.sh'),
      ['--env-file', envFile, ...args],
      box.env,
      repo,
    );
  const ups = () =>
    box
      .dockerLog()
      .filter((line) => / up /.test(line))
      .map((line) => line.split(' --env-file ')[1]!.split(' ').slice(4).join(' '));
  return { box, repo, envFile, first, second, deploy, ups };
}

function pins(dir: string, revision = 'b2') {
  const file = join(dir, 'images.env');
  const names = ['API', 'CONSOLE', 'GATEWAY', 'DISPATCHER', 'WORKER', 'TOOLS'];
  writeFileSync(
    file,
    names
      .map(
        (name, i) =>
          `OVO_${name}_IMAGE=reg.example/ovo/ovo-${name.toLowerCase()}:${revision}@${DIGEST('abcdef'[i]!)}`,
      )
      .join('\n') + '\n',
  );
  return file;
}

describe('deploy-compose.sh (OPS-8)', () => {
  it('pins prebuilt images and restarts the API, then each worker and the gateway in turn', async () => {
    const { box, envFile, deploy, ups, first } = fixture();
    const run = await deploy('--images', pins(box.dir), '--skip-verify');
    expect(run.stderr).toContain('deployed');
    expect(run.code).toBe(0);
    expect(readFileSync(envFile, 'utf8')).toContain(
      `OVO_WORKER_IMAGE=reg.example/ovo/ovo-worker:b2@${DIGEST('e')}`,
    );
    expect(
      box
        .dockerLog()
        .some((line) => line.endsWith('pull api console gateway dispatcher worker-1 worker-2')),
    ).toBe(true);
    expect(box.dockerLog().some((line) => line.includes(' build'))).toBe(false);
    expect(ups()).toEqual([
      '-d --wait postgres queue',
      '-d --no-deps --wait api',
      '-d --no-deps --wait dispatcher',
      '-d --no-deps --wait console',
      '-d --no-deps --wait worker-1',
      '-d --no-deps --wait worker-2',
      '-d --no-deps --wait gateway',
      '-d --wait --remove-orphans',
    ]);
    const history = readFileSync(join(dirname(envFile), '.deploy/history'), 'utf8');
    expect(history).toMatch(
      new RegExp(`ref=${first} images=\\S+/\\.deploy/images-\\S+\\.env previous=${first}\\n$`),
    );
  });

  it('lets a busy worker finish its call before restarting it', async () => {
    const { box, deploy } = fixture({
      workers: { 'worker-1': ['active', 'active', 'ready'], 'worker-2': 'ready' },
    });
    const run = await deploy('--images', pins(box.dir), '--skip-verify');
    expect(run.code).toBe(0);
    expect(run.stderr).toContain('waiting for calls to finish: worker-1:active');
    const log = box.dockerLog();
    const restart = log.findIndex((line) => line.endsWith('up -d --no-deps --wait worker-1'));
    const polls = log.slice(0, restart).filter((line) => line.includes('exec -T worker-1 node -e'));
    expect(polls).toHaveLength(3);
  });

  it('redeploys the pins already in the environment without building', async () => {
    const { box, deploy, ups } = fixture();
    expect((await deploy('--images', pins(box.dir), '--skip-verify')).code).toBe(0);
    const before = box.dockerLog().length;
    const again = await deploy('--skip-verify');
    expect(again.code).toBe(0);
    const log = box.dockerLog().slice(before);
    expect(log.some((line) => line.includes(' build '))).toBe(false);
    expect(
      log.some((line) => line.endsWith('pull api console gateway dispatcher worker-1 worker-2')),
    ).toBe(true);
    expect(ups()).toHaveLength(16);
  });

  it('refuses to build on the call host unless asked', async () => {
    const { deploy, box } = fixture();
    const run = await deploy('--skip-verify');
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('pass --images FILE from build-images.sh, or --build');
    expect(box.dockerLog()).toEqual([]);
  });

  it('rejects a malformed pin file before touching anything', async () => {
    const { deploy, box } = fixture();
    const bad = join(box.dir, 'bad.env');
    writeFileSync(bad, 'OVO_API_IMAGE=reg/ovo-api:1; rm -rf /\n');
    const run = await deploy('--images', bad);
    expect(run.code).toBe(2);
    expect(box.dockerLog()).toEqual([]);
  });

  it('checks out --ref, continues with that revision, and rolls back to the previous deploy', async () => {
    const { repo, deploy, box, envFile, first, second } = fixture();
    expect((await deploy('--build', '--skip-verify')).code).toBe(0);
    const forward = await deploy('--ref', second, '--build', '--skip-verify');
    expect(forward.code).toBe(0);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(second);
    expect(
      box
        .dockerLog()
        .filter((line) => line.endsWith('build api console gateway dispatcher worker-1 worker-2')),
    ).toHaveLength(2);
    const history = () =>
      readFileSync(join(dirname(envFile), '.deploy/history'), 'utf8')
        .trim()
        .split('\n');
    expect(history()[1]).toContain(`ref=${second} images=built previous=${first}`);
    const back = await deploy('--rollback', '--skip-verify');
    expect(back.stderr).toContain(`rolling back to ${first}`);
    expect(back.code).toBe(0);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(first);
    expect(history()[2]).toContain(`ref=${first} images=built previous=${second}`);
  });

  it('--dry-run prints the plan and changes nothing', async () => {
    const { deploy, box, envFile, repo, first } = fixture();
    const before = readFileSync(envFile, 'utf8');
    const run = await deploy('--images', pins(box.dir), '--dry-run');
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('+ compose up -d --no-deps --wait worker-1');
    expect(run.stderr).toContain('+ set OVO_API_IMAGE');
    expect(readFileSync(envFile, 'utf8')).toBe(before);
    expect(box.dockerLog()).toEqual([]);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(first);
  });
});

describe('build-images.sh (OPS-9)', () => {
  it('bakes every target for the VM platform and pins the pushed digests', async () => {
    const { repo, box, first } = fixture({ bakeDigests: true });
    const out = join(box.dir, 'pins.env');
    const run = await runScript(
      join(repo, 'scripts/deploy/build-images.sh'),
      ['--registry', 'asia-south1-docker.pkg.dev/p/ovo', '--push', '--out', out],
      box.env,
      repo,
    );
    expect(run.code).toBe(0);
    const bake = box.dockerLog().find((line) => line.startsWith('buildx bake'))!;
    expect(bake).toContain('-f infra/container/docker-bake.hcl');
    expect(bake).toContain('--push');
    const revision = first.slice(0, 12);
    expect(readFileSync(out, 'utf8').trim().split('\n')).toEqual([
      `OVO_API_IMAGE=asia-south1-docker.pkg.dev/p/ovo/ovo-api:${revision}@${DIGEST('a')}`,
      `OVO_CONSOLE_IMAGE=asia-south1-docker.pkg.dev/p/ovo/ovo-console:${revision}@${DIGEST('b')}`,
      `OVO_GATEWAY_IMAGE=asia-south1-docker.pkg.dev/p/ovo/ovo-gateway:${revision}@${DIGEST('c')}`,
      `OVO_DISPATCHER_IMAGE=asia-south1-docker.pkg.dev/p/ovo/ovo-dispatcher:${revision}@${DIGEST('d')}`,
      `OVO_WORKER_IMAGE=asia-south1-docker.pkg.dev/p/ovo/ovo-worker:${revision}@${DIGEST('e')}`,
      `OVO_TOOLS_IMAGE=asia-south1-docker.pkg.dev/p/ovo/ovo-tools:${revision}@${DIGEST('f')}`,
    ]);
  });

  it('refuses an uncommitted tree and a missing digest', async () => {
    const { repo, box } = fixture();
    writeFileSync(join(repo, 'RELEASE'), 'dirty\n');
    const args = ['--registry', 'reg.example/ovo', '--push', '--out', join(box.dir, 'pins.env')];
    const dirty = await runScript(
      join(repo, 'scripts/deploy/build-images.sh'),
      args,
      box.env,
      repo,
    );
    expect(dirty.code).toBe(2);
    const missing = await runScript(
      join(repo, 'scripts/deploy/build-images.sh'),
      [...args, '--allow-dirty'],
      box.env,
      repo,
    );
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain('wrote no metadata; nothing was pinned');
  });
});

describe('Dockerfile layer order (OPS-9)', () => {
  const dockerfile = readFileSync(join(ROOT, 'infra/container/Dockerfile'), 'utf8');
  it('fetches dependencies from the lockfile alone, before any source is copied', () => {
    const fetch = dockerfile.indexOf('RUN pnpm fetch');
    expect(dockerfile.slice(0, fetch)).toContain('COPY pnpm-lock.yaml pnpm-workspace.yaml ./');
    expect(dockerfile.slice(0, fetch)).not.toMatch(
      /COPY (apps|packages|vendor|scripts|package\.json)/,
    );
    expect(dockerfile.indexOf('RUN pnpm install --frozen-lockfile --offline')).toBeGreaterThan(
      dockerfile.indexOf('COPY apps ./apps'),
    );
  });
  it('builds only glibc images and stamps the revision', () => {
    for (const line of dockerfile.split('\n').filter((l) => l.startsWith('FROM node')))
      expect(line).toMatch(/^FROM node:24\.8\.0-bookworm-slim AS /);
    expect(dockerfile).not.toContain('alpine');
    expect(dockerfile.match(/ENV OVO_REVISION=\$OVO_REVISION/g)).toHaveLength(5);
  });
});
