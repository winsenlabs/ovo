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

it('refuses the internal sip and tcn carrier paths on the public origin, before /carriers/*', () => {
  const { caddyfile } = bootstrap('--public-host', 'voice.ovo.example');
  const proxy = readFileSync(caddyfile, 'utf8');
  const carriers = proxy.indexOf('handle /carriers/* {');
  for (const carrier of ['sip', 'tcn']) {
    const block = `\thandle /carriers/${carrier}/* {\n\t\trespond 404\n\t}\n`;
    expect(proxy).toContain(block);
    expect(proxy.indexOf(block)).toBeLessThan(carriers);
  }
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

it('adds the room server site only with --livekit-host, and points the public URL at it', () => {
  const plain = bootstrap('--public-host', 'voice.ovo.example');
  expect(readFileSync(plain.caddyfile, 'utf8')).not.toContain('7880');
  expect(plain.values()).not.toContain('OVO_LIVEKIT_PUBLIC_URL');
  const both = bootstrap(
    '--public-host',
    'voice.ovo.example',
    '--livekit-host',
    'rooms.ovo.example',
  );
  const proxy = readFileSync(both.caddyfile, 'utf8');
  expect(proxy).toContain('voice.ovo.example {');
  expect(proxy).toContain('rooms.ovo.example {\n\treverse_proxy 127.0.0.1:7880 {');
  expect(proxy).not.toMatch(/__OVO_[A-Z_]+__/);
  expect(both.values().match(/^OVO_LIVEKIT_PUBLIC_URL=.*$/gm)).toEqual([
    'OVO_LIVEKIT_PUBLIC_URL=wss://rooms.ovo.example',
  ]);
  // Opening the site opens no room server: the flags stay as the bootstrap wrote them.
  expect(both.values()).toContain('\nOVO_LIVEKIT_ENABLED=false\n');
  expect(both.values()).toContain('\nOVO_LIVEKIT_PUBLIC_ENABLED=false\n');
});

it('refuses --livekit-host without --public-host, with a bad name, or the same name', () => {
  const { run } = bootstrap();
  const fails = (...args: string[]) => {
    try {
      run(...args);
      return undefined;
    } catch (error) {
      return String((error as { stderr?: Buffer | string }).stderr);
    }
  };
  expect(fails('--livekit-host', 'rooms.ovo.example')).toContain('needs --public-host');
  expect(fails('--public-host', 'voice.ovo.example', '--livekit-host', 'Rooms')).toContain(
    'lower-case DNS name',
  );
  expect(
    fails('--public-host', 'voice.ovo.example', '--livekit-host', 'voice.ovo.example'),
  ).toContain('different');
});
