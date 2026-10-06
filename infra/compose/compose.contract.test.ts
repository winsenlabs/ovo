import { execFileSync } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./compose.yaml', import.meta.url), 'utf8');

function service(name: string): string {
  const start = source.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`Missing Compose service ${name}`);
  const remainder = source.slice(start + 1);
  const end = remainder.slice(1).search(/\n  [a-z][a-z0-9-]*:\n|\n[^ \n]/);
  return end < 0 ? remainder : remainder.slice(0, end + 1);
}

it.each([
  ['api', 'OVO_MEDIA_PUBLIC_BASE_URL'],
  ['api', 'OVO_INBOUND_ROUTE_SECRET'],
  ['worker-1', 'OVO_INBOUND_ROUTE_SECRET'],
  ['worker-2', 'OVO_INBOUND_ROUTE_SECRET'],
])('supplies %s with its required %s', (name, key) => {
  let definition = service(name);
  if (name === 'worker-2') {
    expect(definition).toContain('<<: *worker');
    const worker = service('worker-1');
    expect(worker).toContain('environment: &worker');
    definition += worker;
  }
  expect(definition).toContain(`${key}: \${${key}:?set ${key}}`);
});

it('trusts forwarded TLS only from the pinned console address', () => {
  expect(service('api')).toContain(
    'OVO_TRUSTED_PROXY_CIDRS: ${OVO_CONSOLE_ADDRESS:-172.29.240.10}/32',
  );
  expect(service('console')).toContain('ipv4_address: ${OVO_CONSOLE_ADDRESS:-172.29.240.10}');
  expect(source).toContain('- subnet: ${OVO_COMPOSE_SUBNET:-172.29.240.0/24}');
});

it('verifies sign-in over forwarded TLS when local HTTP is disabled', () => {
  const verifier = readFileSync(
    new URL('../../scripts/verify-compose.sh', import.meta.url),
    'utf8',
  );
  expect(verifier).toContain("...(localHttp ? {} : { 'x-forwarded-proto': 'https' })");
  expect(verifier).toContain('TLS sign-in did not issue a Secure cookie');
});

it('passes OVO_LOG_LEVEL to every service and the transcript-text policy to the workers', () => {
  const common = source.slice(
    source.indexOf('x-common-environment'),
    source.indexOf('\nservices:'),
  );
  expect(common).toContain('OVO_LOG_LEVEL: ${OVO_LOG_LEVEL:-info}');
  for (const name of ['api', 'gateway', 'dispatcher', 'worker-1', 'secrets-rewrap'])
    expect(service(name)).toContain('<<: *common');
  expect(service('worker-1')).toContain(
    'OVO_TELEMETRY_TRANSCRIPT_TEXT: ${OVO_TELEMETRY_TRANSCRIPT_TEXT:-store}',
  );
  expect(service('worker-1')).toContain(
    'OVO_TELEMETRY_TRANSCRIPT_TEXT_AGENTS: ${OVO_TELEMETRY_TRANSCRIPT_TEXT_AGENTS:-}',
  );
  expect(service('worker-2')).toContain('<<: *worker');
});

it('gives the API the same capacity ceiling as the dispatcher', () => {
  expect(service('api')).toContain("OVO_WORKER_MAX_CAPACITY: '2'");
  expect(service('dispatcher')).toContain("OVO_WORKER_MAX_CAPACITY: '2'");
});

it('lets every service that decrypts credentials read the previous master key', () => {
  for (const name of ['api', 'gateway', 'worker-1', 'secrets-rewrap']) {
    expect(service(name)).toContain('OVO_SECRETS_MASTER_KEY: ${OVO_SECRETS_MASTER_KEY:?');
    expect(service(name)).toContain(
      'OVO_SECRETS_MASTER_KEY_PREVIOUS: ${OVO_SECRETS_MASTER_KEY_PREVIOUS:-}',
    );
  }
});

it('runs the master key rewrap only as an opt-in tool against the shipped command', () => {
  const tool = service('secrets-rewrap');
  expect(tool).toContain('profiles: [tools]');
  expect(tool).toContain('target: workspace');
  expect(tool).toContain('entrypoint: [pnpm, exec, tsx, apps/api/src/secrets-rewrap.ts]');
  expect(existsSync(new URL('../../apps/api/src/secrets-rewrap.ts', import.meta.url))).toBe(true);
});

const script = (name: string) => new URL(`../../scripts/${name}`, import.meta.url);

it('renders no env carrier binding and never interpolates Twilio credentials', () => {
  expect(source).toContain("  OVO_CARRIER_ENV_BINDINGS: '{}'\n");
  expect(source).not.toMatch(/\$\{TWILIO_/);
});

it('fails verification when any service still carries an env carrier binding', () => {
  const verifier = readFileSync(script('verify-compose.sh'), 'utf8');
  expect(verifier).toContain('for service in api gateway worker-1 worker-2; do');
  expect(verifier).toContain('Compose must not configure an env carrier binding');
});

describe('bootstrap Twilio values', () => {
  const run = (envFile: string) =>
    execFileSync('bash', [script('bootstrap-compose.sh').pathname, '--env-file', envFile], {
      env: { ...process.env, OVO_SEED_ADMIN_EMAIL: 'admin@ovo.test' },
      stdio: 'pipe',
    });
  const read = (envFile: string, key: string) =>
    readFileSync(envFile, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith(`${key}=`));

  it('writes empty values and clears placeholders an older bootstrap wrote', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ovo-bootstrap-'));
    try {
      const fresh = join(directory, 'fresh.env');
      run(fresh);
      expect(read(fresh, 'TWILIO_ACCOUNT_SID')).toEqual(['TWILIO_ACCOUNT_SID=']);
      expect(read(fresh, 'TWILIO_AUTH_TOKEN')).toEqual(['TWILIO_AUTH_TOKEN=']);

      const older = join(directory, 'older.env');
      writeFileSync(
        older,
        'OVO_SESSION_SECRET=kept-session-secret\nTWILIO_ACCOUNT_SID=disabled-local-account\nTWILIO_AUTH_TOKEN=disabled-local-token\n',
        { mode: 0o600 },
      );
      run(older);
      expect(read(older, 'TWILIO_ACCOUNT_SID')).toEqual(['TWILIO_ACCOUNT_SID=']);
      expect(read(older, 'TWILIO_AUTH_TOKEN')).toEqual(['TWILIO_AUTH_TOKEN=']);
      expect(read(older, 'OVO_SESSION_SECRET')).toEqual(['OVO_SESSION_SECRET=kept-session-secret']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

it('keeps inbound admission tied to the flag and reports readiness from the dispatcher', () => {
  expect(service('worker-1')).toContain(
    'OVO_INBOUND_CAPACITY_ENABLED: ${OVO_INBOUND_ENABLED:-false}',
  );
  expect(service('dispatcher')).toContain('OVO_INBOUND_ENABLED: ${OVO_INBOUND_ENABLED:-false}');
  const verifier = readFileSync(script('verify-compose.sh'), 'utf8');
  expect(verifier).toContain("fetch('http://127.0.0.1:4002/health')");
  expect(verifier).toContain('Inbound admission is enabled but no protected slot is ready');
});

it('gives draining calls time before Docker escalates to SIGKILL', () => {
  for (const name of ['gateway', 'worker-1', 'worker-2'])
    expect(service(name)).toContain('stop_grace_period: 300s');
  const drain = /OVO_MEDIA_DRAIN_TIMEOUT_MS: '(\d+)'/.exec(service('gateway'));
  expect(drain).not.toBeNull();
  // The drain must finish, with room for cleanup, inside the 300s grace period.
  expect(Number(drain![1])).toBeLessThanOrEqual(300_000 - 30_000);
  expect(() => accessSync(script('wait-compose-idle.sh'), constants.X_OK)).not.toThrow();
});
