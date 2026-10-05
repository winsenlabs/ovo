import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

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
