// bootstrap-compose.sh --public-host (OPS-8): a fresh VM gets its public origin, TLS-only API and
// reverse-proxy config from one command.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ROOT } from '../../ops/tests/fake-stack.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function bootstrap(...args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'ovo-public-'));
  dirs.push(dir);
  const envFile = join(dir, '.env');
  const caddyfile = join(dir, 'Caddyfile');
  const run = (...more: string[]) =>
    execFileSync(
      'bash',
      [
        join(ROOT, 'scripts/bootstrap-compose.sh'),
        '--env-file',
        envFile,
        '--caddyfile',
        caddyfile,
        ...more,
      ],
      {
        env: { ...process.env, OVO_SEED_ADMIN_EMAIL: 'admin@ovo.test' },
        encoding: 'utf8',
        stdio: 'pipe',
      },
    );
  run(...args);
  return { envFile, caddyfile, run, values: () => readFileSync(envFile, 'utf8') };
}

it('sets the public origin, forbids plain HTTP and renders the reverse proxy for the host', () => {
  const { envFile, caddyfile, values } = bootstrap('--public-host', 'voice.ovo.example');
  const env = values();
  expect(env.match(/^OVO_MEDIA_PUBLIC_BASE_URL=.*$/gm)).toEqual([
    'OVO_MEDIA_PUBLIC_BASE_URL=https://voice.ovo.example',
  ]);
  expect(env.match(/^OVO_ALLOW_LOCAL_HTTP=.*$/gm)).toEqual(['OVO_ALLOW_LOCAL_HTTP=false']);
  expect(statSync(envFile).mode & 0o777).toBe(0o600);
  const proxy = readFileSync(caddyfile, 'utf8');
  expect(proxy).toContain('voice.ovo.example {');
  expect(proxy).toContain('handle /carriers/* {\n\t\treverse_proxy 127.0.0.1:4001 {');
  expect(proxy).toContain('handle /ovo-gateway-health {');
  // The public health answers only the ready flag, never the gateway's live session count.
  expect(proxy).toContain('respond `{"ready":true}` 200');
  expect(proxy).toContain('respond `{"ready":false}` 503');
  expect(proxy).toContain('reverse_proxy 127.0.0.1:3000');
  expect(proxy).not.toMatch(/__OVO_[A-Z_]+__/);
});

it('replaces the placeholder origin of an earlier local bootstrap but keeps its secrets', () => {
  const { run, values } = bootstrap();
  const secret = values().match(/^OVO_SECRETS_MASTER_KEY=.*$/m)![0];
  expect(values()).toContain('OVO_MEDIA_PUBLIC_BASE_URL=https://voice.invalid');
  run('--public-host', 'voice.ovo.example');
  expect(values()).toContain('OVO_MEDIA_PUBLIC_BASE_URL=https://voice.ovo.example');
  expect(values()).not.toContain('voice.invalid');
  expect(values()).toContain(secret);
});

it.each([
  'https://voice.ovo.example',
  'voice.ovo.example:443',
  'Voice.Example',
  'localhost',
  'a b.example',
])('rejects %s as a public host', (host) => {
  const dir = mkdtempSync(join(tmpdir(), 'ovo-public-'));
  dirs.push(dir);
  writeFileSync(join(dir, '.env'), '', { mode: 0o600 });
  expect(() =>
    execFileSync(
      'bash',
      [
        join(ROOT, 'scripts/bootstrap-compose.sh'),
        '--env-file',
        join(dir, '.env'),
        '--public-host',
        host,
      ],
      {
        stdio: 'pipe',
      },
    ),
  ).toThrow(/--public-host must be a lower-case DNS name/);
});
