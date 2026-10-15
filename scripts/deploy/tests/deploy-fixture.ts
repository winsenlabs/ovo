// Shared by the deploy-compose / build-images script tests: a scratch git repository holding copies
// of the deploy scripts and the stand-in docker, so every Compose command is recorded and none runs.
// Each test file registers `afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))`.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runScript, sandbox, ROOT } from '../../ops/tests/fake-stack.ts';

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
export const DIGEST = (c: string) => `sha256:${c.repeat(64)}`;

export const cleanups: Array<() => void> = [];

export function git(repo: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd: repo,
    encoding: 'utf8',
  }).trim();
}

export function fixture(dockerState: Record<string, unknown> = {}) {
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
  const history = () =>
    readFileSync(join(dirname(envFile), '.deploy/history'), 'utf8')
      .trim()
      .split('\n');
  const setDocker = (patch: Record<string, unknown>) => {
    const file = box.env.FAKE_DOCKER_STATE;
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), ...patch }));
  };
  return { box, repo, envFile, first, second, deploy, ups, history, setDocker };
}

export const image = (envFile: string, name: string) =>
  readFileSync(envFile, 'utf8').match(new RegExp(`^OVO_${name}_IMAGE=(.*)$`, 'm'))?.[1];

export function pins(dir: string, revision = 'b2', sip = false) {
  const file = join(dir, 'images.env');
  const names = ['API', 'CONSOLE', 'GATEWAY', 'DISPATCHER', 'WORKER', 'TOOLS'];
  if (sip) names.push('SIP_GATEWAY');
  writeFileSync(
    file,
    names
      .map(
        (name, i) =>
          `OVO_${name}_IMAGE=reg.example/ovo/ovo-${name.toLowerCase().replace('_', '-')}:${revision}@${DIGEST('abcdef7'[i]!)}`,
      )
      .join('\n') + '\n',
  );
  return file;
}
